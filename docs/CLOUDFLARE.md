# Webflix on Cloudflare

The serverless deployment mode: one Worker on D1, KV, R2, Durable Objects, Queues, Cron
Triggers, static assets and the Workers edge cache. It runs the same `createServices` /
`createApp` as the Node modes (docs/BACKEND.md §5); everything Cloudflare-specific lives in
`apps/edge` and `packages/adapters-cloudflare`.

```sh
make cf-dev               # fresh clone → http://localhost:8787 (workerd + miniflare, all bindings local)
make cf-deploy-dry-run    # rehearse the production path without an account
make cf-deploy            # provision, migrate, upload media, seed, deploy, verify (real account)
```

Numbers in this document were measured on 2026-11-21 (wrangler 4.166.0, workerd 1.20261119,
compatibility date 2026-11-19); platform limits and prices are from the Cloudflare docs of
that date.

---

## 1. Ports and the services behind them

| Port | Cloudflare | Why this service |
| --- | --- | --- |
| Database (Kysely) + `SearchIndex` | **D1** (`@webflix/db/d1`, FTS5) | Relational data with SQL, transactions per `batch()`, FTS5 search. Migrations are the SQL files generated from the TypeScript migrations (`packages/db/migrations/d1`), applied by `wrangler d1 migrations apply`. |
| `KeyValueCache` | **Workers KV** (`createKvCache`) | Read-mostly, eventually consistent, cached at every location: exactly what the catalog snapshot and popularity cache need (docs/DECISIONS.md D7). Nothing read-after-write lives here. |
| `BlobStore` | **R2** (`createR2BlobStore`), reads through the **Workers edge cache** (`createEdgeCachedBlobStore` + the `MediaOrigin` entrypoint) | Zero-egress object storage with ranges and conditional reads; the edge cache in front of it is where segments should be served from. §3. |
| `RateLimiter` | **Durable Object per `policy:key`** (`RateLimiterObject`) | The port demands exact, atomic counts across all isolates and locations. KV is eventually consistent and the rate-limiting binding is approximate per location: neither can. |
| `StreamGate` | **Durable Object per account** (`StreamGateObject`, SQLite storage) | Concurrent-stream limits need a strongly consistent, serialised view of one account's slots, from every device, anywhere. That is the definition of a Durable Object. |
| `JobQueue` | **Queues** producer + the Worker's `queue()` consumer, dead-letter queue | Durable, at-least-once, batched delivery with per-message retry and backoff; jobs are idempotent by design (D8). |
| Scheduler | **Cron Trigger** `*/5 * * * *` → `scheduled()` | Publishes the periodic jobs (stats rollups, daily baseline, cleanup). Cheap, idempotent, safe to overlap. |
| `PasswordHasher` | PBKDF2-SHA256 on WebCrypto, iterations from `WEBFLIX_PASSWORD_ITERATIONS` | The strongest KDF Workers provide natively; the CPU cost is made explicit (§6). |
| `TokenSigner` | HMAC-SHA256, keys in the `WEBFLIX_MEDIA_TOKEN_KEYS` **secret** | Stateless media tokens verified on every segment without I/O. |
| SPA | **Workers static assets**; the Worker answers misses (`src/spa.ts`) | Files are served by the asset layer before the Worker: free requests, cached, no Worker CPU. |

### Durable Object design

Both classes are SQLite-backed (`exports` in wrangler.jsonc, the current way to declare them;
`migrations` is legacy and mutually exclusive with it) and use the synchronous storage APIs:

- **`RateLimiterObject`**, one per `policy:key` (`auth:ip:203.0.113.7`, `profile-pin:account:…`).
  GCRA with a single stored timestamp, the same algorithm and float tolerance as the memory
  adapter. `consume` is synchronous over `ctx.storage.kv`, so no other request to the object
  can interleave with its read-modify-write; the output gate holds the answer until the write
  is durable. A denied request writes nothing (an attack costs reads only). When the bucket
  refills completely the state is meaningless, so an alarm deletes it: idle limiters cost no
  storage. Keys spread over objects, so one abusive client saturates only its own object
  (soft limit ~1,000 req/s per object); volumetric abuse belongs to WAF rules in front.
- **`StreamGateObject`**, one per account. A `leases` table; `acquire`, `renew` and the
  releases run inside `transactionSync` and never yield, so concurrent "start playback" from
  every device of an account is serialised here and can never exceed the plan (verified by the
  contract suite and by the conformance suite's concurrent-start check). One lease per device;
  re-acquiring renews. An alarm at the earliest expiry drops dead leases; when the last lease
  goes, the object deletes all its storage (and its alarm), so only accounts that are watching
  something hold any state. Sign-out-everywhere calls `releaseAll`: effective on the next
  request of every device.
- Time: expiry is evaluated against the caller's `now` (the contract suites drive it with a
  `ManualClock`); alarms are scheduled on the object's own clock. Requests to an object
  `getByName(account)` are routed to wherever it lives (created near its first caller).

### Queues

- Producer: messages are sent as `json` envelopes `{v: 1, type, payload}` so what is enqueued
  is exactly the JSON the job schemas accept and dead letters are readable anywhere.
- Consumer (`createQueueConsumer`): each message is settled on its own (`ack` / `retry`),
  never the batch, so one failing job does not redeliver the others. The processor's backoff
  (5 s × 2^(attempt−1), capped) becomes `retry({ delaySeconds })`. Unknown types, invalid
  payloads and malformed envelopes are retried, never dropped. After `max_retries: 4`
  (5 attempts, `JOBS_MAX_ATTEMPTS`; a test keeps the two in sync) Queues moves the message to
  `webflix-jobs-dlq`; the final attempt is logged as `job.dead_lettered`.
- The dead-letter queue has no consumer on purpose: messages stay there for inspection and
  replay from the dashboard or a pull consumer, instead of being consumed into a log line.
  Provisioning creates it with the maximum retention (14 days on Paid; Free is fixed at 24 h).
- `max_batch_size 10`, `max_batch_timeout 5 s` (2 s locally), `max_concurrency 2`: jobs are
  small D1-bound units; bounded concurrency keeps the single-threaded D1 primary responsive.

---

## 2. Request flow

```
browser ── GET / , /assets/*.js, /favicon.svg (files that exist) ─► static assets
   │                                                            no Worker, free, cached
   ├─ anything else with no file ─► Worker (`src/spa.ts`): client route → index.html;
   │                               file-like path (/assets/*, *.ext) → 404, no-store
   │
   ├─ /api/*, /media/*, /cdn/*, /healthz, /readyz ─► Worker `fetch` (gateway, never cached)
   │                     │   createApp: request id, security headers, CSRF header, session
   │                     │   (D1), rate limit (DO), handlers
   │                     ├─ /api/v1/...      D1 (+ DO for playback/heartbeats/limits, Queues)
   │                     ├─ /media/{token}/vod/...  token verified (HMAC, no I/O);
   │                     │       *.m3u8: + D1 playback row + StreamGate DO (slot still held)
   │                     │       then BlobStore.get ─┐
   │                     └─ /cdn/...  BlobStore.get ─┤
   │                                                 ▼
   │                      ctx.exports.MediaOrigin.fetch("/{generation}/{blob key}", Range)
   │                         └─► Workers edge cache (tiered, request-collapsing; slices ranges)
   │                               └─ miss ─► MediaOrigin entrypoint ─► R2 (whole object)
   │
   ├─ /api/docs ─► Worker (HTML with per-response CSP nonce)
   └─ /api/docs/scalar.js ─► static assets (excluded from run_worker_first)

Cron */5 ─► scheduled() ─► Queues ─► queue() ─► job handlers (D1, KV)
```

`run_worker_first` lists the server-owned prefixes (the same prefixes the web dev server
proxies to the API, and `SERVER_PATHS` in `src/spa.ts`; tests keep all three equal), so a
browser *navigation* to `/api/...`, `/media/...` or `/cdn/...` reaches the Worker and gets
JSON, never the SPA shell.

Requests that match no file reach the Worker too (`not_found_handling: "none"`). The asset
layer's own SPA mode is not used: it would answer a chunk an old tab still asks for after a
deploy (`/assets/index-<old hash>.js`) with `index.html`, status 200, under the immutable
`/assets/*` headers, so browsers and shared caches would keep HTML under that JS URL for a year
and a rollback would not heal it. `src/spa.ts` instead answers anything under `/assets/`, and
any path whose last segment has an extension unless it is a navigation, with a 404 problem
document and `Cache-Control: no-store`; every other miss is a client-side route and gets
`index.html` from the asset layer (deep links survive a hard refresh; ETag revalidation).
Deep links therefore cost one Worker request (no I/O beyond the asset fetch); in-app
navigation never reaches the server.

Security headers on the SPA come from the Helm chart, the same source the Kubernetes mode's
nginx uses: the CSP in `deploy/helm/webflix/values.yaml` (`web.contentSecurityPolicy`) and the
`add_header` lines of `templates/web/configmap.yaml` (nosniff, frame DENY, referrer policy,
COOP, CORP, Permissions-Policy; HSTS when served over https). `scripts/lib/security-headers.ts`
reads both and writes them into `_headers`; it refuses template constructs it cannot evaluate,
and `test/node/security-headers.test.ts` renders the chart with `helm template` and fails if
the two modes differ. The asset layer applies `_headers` to the shell the Worker fetches for
deep links as well. Checked in Chromium on landing, browse, the detail overlay with its preview
clip, and the API docs: no CSP violations from the SPA policy and no third-party requests (the
docs page has its own CSP from `packages/http`; see the report for its one `eval` block).

Per isolate vs per request: config validation, the service graph, the catalog/popularity
memo (30–60 s), the UUIDv7 generator and the media-generation memo (60 s) are built once per
isolate (`getRuntime`, keyed by the `env` object) and reused by every request; construction
does no I/O, so a cold start costs only module evaluation. Per request: the Hono context,
the session lookup (memoised within the request), and nothing else.

---

## 3. Caching: what is cached where, and why it is safe

Protected media URLs carry a per-session token in the path (`/media/{token}/vod/...`, so
relative URIs inside playlists inherit it). Caching those URLs would give every session its
own entry (no sharing), and caching them without the token would skip authorisation. The
design separates the two concerns, following Cloudflare's "authorise in a gateway, cache in a
named entrypoint" pattern:

1. **The gateway is never cached** (top-level `cache.enabled: false`). It authenticates and
   authorises every request: token signature and expiry for segments; for playlists also the
   playback row and the stream slot in the Durable Object (D1 decision of docs/DECISIONS.md).
2. **Blob reads go to the cache-enabled `MediaOrigin` entrypoint** through `ctx.exports`, at a
   token-free internal URL `/{generation}/{blob key}`. Every viewer of the same segment shares
   one tiered, request-collapsed edge entry. `MediaOrigin` is not routable from the internet.
3. The origin answers with the whole object (`Cache-Control: public, max-age=604800`,
   `Cache-Tag: webflix-media`); the edge cache strips `Range` before invoking it and slices
   ranges itself (a 206 is never stored). Where no cache sits in between (local `wrangler dev`)
   the origin sees `Range` and answers 206 itself, so the code path is identical everywhere.
   Port metadata (etag, upload time, content type) crosses the cache in a header, so the HTTP
   layer still answers conditional (`If-None-Match` → 304) and `If-Range` requests exactly.
4. **Blob keys are not content-addressed** (re-packaging rewrites `vod/{asset}/...` in place),
   so the internal URL includes a **media generation** that follows what the bucket serves
   (`src/media-generation.ts`, `scripts/lib/generation.ts`), in every path that changes it:
   - before an upload rewrites anything, the generation becomes `uploading-<time>`: readers
     bypass the edge cache and read R2 directly, so a mix of old and new objects is never
     stored; in production the upload then waits 120 s (the 60 s memo plus KV propagation)
     so every isolate has stopped caching under the old generation;
   - after every object and then the manifest (written last) are in the bucket, it becomes the
     hash of that manifest: a generation always names a complete upload;
   - a failed upload leaves the bypass on (correct, slower) until an upload completes; the seed
     follows the bucket's manifest but never clears an upload in progress; `--prune` runs only
     once the new media is live and seeded.
   Code deploys keep the media cache warm (`cross_version_cache: true`). What remains is
   inherent to in-place keys: a player that is streaming an asset while that very asset is
   rewritten can get bytes of both versions from R2; nothing mixed is cached, and new
   playbacks see one consistent version.

What the browser caches is decided by the HTTP layer, unchanged from the other modes:
`/cdn` immutable for a year (URLs carry `?v=<hash>`), segments `private, max-age ≤ min(1 h,
token lifetime)`, playlists `private, no-cache`, API `no-store` + `Vary: Cookie`. The gateway
adds `Cache-Control: no-store` to any response that has none (the edge cache key ignores
cookies, so nothing may be cacheable by accident). Static assets: hashed files immutable,
`index.html` revalidated by ETag; a missing file is a 404 with `no-store` (§2).

The one cacheable API response, the public showcase (`GET /api/v1/showcase`, `public,
max-age=300, stale-while-revalidate=86400`), is not cached by the Worker. A Cache API layer was
tried and removed: the stored response's `stale-while-revalidate` kept a pre-re-seed showcase
servable for a day (observed locally), and it saved little, since `@webflix/core` already keeps
the showcase per isolate (60 s) and in KV (5 min), both invalidated by the seed. Browsers and
any shared cache in front still use its `Cache-Control` and ETag.

`WEBFLIX_EDGE_CACHE=off` reads R2 directly from the gateway (same semantics, no edge cache).

What is verified: the read path's port semantics with and without a caching intermediary that
strips `Range` and slices from a stored full object (the `BlobStore` contract suite runs on
both, `packages/adapters-cloudflare/test/edge-cache.test.ts`), one origin fetch for repeated
and ranged reads, generation-scoped misses, and the whole path in `wrangler dev`. What is not:
the Workers edge cache itself, which local development does not emulate (§8).

---

## 4. Consistency

| State | Store | Consistency | Why acceptable |
| --- | --- | --- | --- |
| Sessions, revocation, account, profiles, library, progress | D1 (primary) | Strong (single primary, read-after-write) | Sign-out-everywhere and password changes must be effective on the next request anywhere. |
| Stream slots | `StreamGateObject` | Strong, serialised per account | The plan limit is a hard business rule. |
| Rate limits | `RateLimiterObject` | Strong, serialised per key | The port requires exact counts. |
| Catalog snapshot, popularity | isolate memo 30–60 s → KV 5 min → D1 | Eventual (≤ ~6 min after a re-seed or rollup) | Non-personal, changes rarely; personal state is never cached (D7). |
| Media generation | isolate memo 60 s → KV | Eventual (≤ ~2 min) | §3. |
| Daily stats, Trending, Top 10 | Queues jobs → D1 | Eventual (seconds to minutes), at-least-once | Rollups recompute a day from playback sessions, so redelivery cannot double count (D8). |

**D1 read replication is deliberately off.** It would cut read latency far from the primary,
but replicas lag: a revoked session could still authenticate on a lagging replica, which
breaks "sign out everywhere, immediately". Turning it on correctly means the Sessions API with
a bookmark per client (cookie) and `first-primary` for the session lookup itself; that is the
next lever for global latency, not a flag to flip.

---

## 5. Budgets and limits

### Per request (measured)

Binding calls per request through the real Worker, `apps/edge/test/budgets.test.ts` (it wraps
every binding in a counter and asserts these):

| Request | D1 queries | Durable Object | R2 | KV | Queues |
| --- | --- | --- | --- | --- | --- |
| `GET /api/v1/browse` (warm isolate) | 2 | 0 | 0 | 0 | 0 |
| `GET /api/v1/titles/:id` | 2 | 0 | 0 | 0 | 0 |
| `GET /api/v1/search` | 4 | 0 | 0 | 0 | 0 |
| `POST /api/v1/auth/login` | 4 | 1 (rate limit) | 0 | 0 | 0 |
| `POST /api/v1/playback/sessions` | 5 | 2 (rate limit, acquire) | 0 | 0 | 0 |
| `POST …/heartbeat` (every 30 s) | 3 | 1 (renew) | 0 | 0 | 0 |
| `GET …/master.m3u8` | 1 | 1 (slot check) | 1 | 0 | 0 |
| `GET …/seg_N.m4s` | 0 | 0 | 1 (edge-cache miss only); 2 for the first segment of an asset in an isolate (the plan-cap rendition map reads the master playlist, memoised 10 min) | 0 | 0 |

A batch counts as one D1 query. Limits: 1,000 D1 queries and 10,000 subrequests per invocation
on Paid (Free: 50 D1 queries, 1,000 subrequests to Cloudflare services), 6 simultaneous
connections. The heaviest hot path uses 7 calls.
A cold isolate adds 2 KV reads (snapshot, popularity) or, on a KV miss, the D1 loads.

D1 itself: one primary per database processes queries one at a time (throughput ≈ 1 / query
time). Hot paths are batched for this reason; heartbeats (3 small queries every 30 s per
viewer) are the steady write load: ~1,000 concurrent viewers ≈ 100 queries/s. Beyond tens of
thousands of concurrent viewers, heartbeats should move to the per-account Durable Object
(progress flushed to D1 in batches); the port boundary allows that without touching services.

### CPU, startup, bundle

| | Measured | Limit |
| --- | --- | --- |
| Production bundle (minified) | 496.7 KiB, 138.5 KiB gzip (was 845.8 KiB before zod's namespace imports) | 64 MiB uncompressed (no compressed limit) |
| Startup CPU (`make cf-startup`, local M-series, median of 7) | ~37 ms (was ~40.5 ms) | 1 s |
| Sign-in (PBKDF2 600k), wall time locally | 55–65 ms | CPU: 10 ms Free, `limits.cpu_ms: 1000` set in production |
| Static assets | 120 files, 6.6 MB (4.4 MB is the Scalar API reference) | 100,000 files, 25 MiB each |

zod used to be the largest part of the Worker: `import { z } from "zod"` binds zod's own
namespace object, which esbuild keeps whole with every locale table (260.6 KiB of the 458.8 KiB
zod took in the minified bundle). Every zod import is now `import * as z from "zod"` (guard
tests in `packages/core` and `apps/edge`), which leaves zod at 110.0 KiB with 2.7 KiB of
locales and unchanged validation messages; `make cf-bundle` reports zod's share and fails if
the locale tables come back (> 16 KiB). Nothing is close to a limit.

### Free vs Paid

Production requires **Workers Paid** ($5/month), and the deployment as configured assumes it:
a 600k-iteration PBKDF2 hash costs ~45 ms of CPU where Free allows 10 ms per invocation;
`limits.cpu_ms` is a Paid setting; the dead-letter queue is created with 14-day retention
(Free is fixed at 24 h); Free's 100,000 requests/day is ~25 viewing hours. There is no
supported Free-plan variant. What one would need (unbuilt, untested): drop `limits`, create the
dead-letter queue without the retention flag, and set `WEBFLIX_PASSWORD_ITERATIONS=100000`
(the lowest the config accepts, ~7–8 ms per hash, still close to the 10 ms budget with
everything else a sign-in does). Locally none of this applies: `make cf-dev` emulates every
binding regardless of plan.

### Cost drivers

Per viewing hour (4 s segments, separate audio: ~1,800 segment requests; 120 heartbeats):

| Item | Volume | Price (beyond included) | Cost |
| --- | --- | --- | --- |
| Gateway requests | ~1,925 | $0.30 / M | $0.0006 |
| `MediaOrigin` requests (billed when caching is enabled) | ~1,800 | $0.30 / M | $0.0005 |
| R2 Class B reads | edge misses only (≤ 1,800) | $0.36 / M | ≤ $0.0006 |
| Durable Object requests | ~125 | $0.15 / M | < $0.0001 |
| D1 rows written (heartbeats) | ~360 | $1.00 / M | $0.0004 |
| Egress | ~0.5–2 GB | R2 and Workers: $0 | $0 |

About **$0.002 per viewing hour**, dominated by Workers requests (two per segment). Levers:
longer segments (6 s cuts requests by a third), serving `/cdn` artwork from an R2 custom
domain (no Worker in the path; requires relaxing the same-origin `/cdn` rule), heartbeats in
the Durable Object. Storage is $0.015/GB-month (the fast profile is 1.6 GB).

---

## 6. Password hashing: the explicit trade-off

- `WEBFLIX_PASSWORD_ITERATIONS` (default **600,000**, OWASP 2023 for PBKDF2-HMAC-SHA256;
  validated range 100,000–10,000,000) sets the cost of new hashes (passwords and profile
  PINs). Hashes are self-describing (PHC), so lowering it never weakens existing hashes
  (they verify at their own cost) and raising it upgrades them on the next sign-in.
- A sign-in costs one derivation (~45 ms CPU at the default); an unknown address costs one
  too (a dummy hash, so both answer in the same time) plus, once per isolate, the dummy
  itself. Sign-up, PIN set/check and password change cost one or two.
- Every route that hashes consumes its rate-limit budget (Durable Objects, exact across the
  network) before any hashing happens, so one rate-limit key can cause at most `limit`
  derivations per window. Which requests share a key (a client address, an address prefix,
  an account) is the HTTP layer's policy (`packages/http`), and that policy, not the platform,
  decides how far one client with many addresses can multiply the cost.
- Node modes use memory-hard scrypt; scrypt hashes do not verify on Workers. A database moved
  from a Node mode to Cloudflare needs those users to reset or sign in once on Node first.

---

## 7. Local workflow

```sh
make cf-dev          # everything below, then wrangler dev on :8787 (Ctrl-C to stop)
make cf-stop         # stop this repository's dev server on CF_PORT (never another program's)
make cf-cron         # run the Cron Trigger on the running Worker
make cf-status       # what local state holds (seed, manifest, media generation)
make cf-seed FORCE=1 # re-apply the seed (resets the demo account)
make cf-media CF_MEDIA_PROFILE=full
make cf-reset        # stop, then delete the instance's state (D1, KV, R2, Durable Objects, Queues)
make cf-test         # adapter contract suites + Worker tests, in workerd
make cf-bundle       # production bundle + size report;  make cf-startup: startup CPU profile
```

`make cf-dev` from a fresh clone: install (if needed) → `.dev.vars` with a random per-clone
media-token key → web build (turbo-cached; if a work-in-progress edit breaks it, the last
successful build is served with a warning) → stage static assets → `wrangler d1 migrations
apply --local` → media upload into local R2 (if `make content` has packaged media) → seed →
`wrangler dev --test-scheduled`. Measured: **121 s** from nothing (most of it uploading the
1.6 GB fast profile), **7 s** on a re-run (nothing re-uploaded or re-seeded).

**Several instances side by side.** Every target takes the instance's port, inspector port,
state directory and staged-assets directory, so a second copy never touches the first:

```sh
make cf-dev CF_PORT=4620 CF_INSPECTOR_PORT=4621 CF_STATE=/tmp/cf-b/state CF_ASSETS=/tmp/cf-b/public
make cf-stop CF_PORT=4620 CF_STATE=/tmp/cf-b/state
```

`make cf-dev` runs the server through `scripts/dev.ts`, which records its PID, port and working
directory in `<CF_STATE>/dev-server.json`. `make cf-stop` signals only that recorded runner while
it is still alive, still `scripts/dev.ts` and still running in `apps/edge`; without a valid
record (a server started some other way) only a wrangler process running in `apps/edge` behind
the port. Anything else listening on the port (8787 is Wrangler's default, so another
project's dev server may be there) is left alone, with an explanation, and the target fails.

**How seeding and media reach local state.** `scripts/ops.ts` runs in Node and gets the
Worker's bindings from Wrangler's `getPlatformProxy`, started from a bindings-only config
derived from wrangler.jsonc (D1, KV, R2 and vars of one environment). Locally it persists to
`<CF_STATE>/v3`, the exact state `wrangler dev --persist-to <CF_STATE>` serves, and it refuses
to run while something serves the instance's port (two runtimes must not own one state
directory). Then:

- media: `tools/media`'s own upload function (`uploadProfile`) through `createR2BlobStore`,
  the same adapter the Worker reads with, wrapped in the generation lifecycle of §3.
  Idempotent (size + SHA-256 records); the manifest is written last to `manifests/media.json`;
  a re-run whose manifest is already in the bucket skips the listing entirely.
- seed: the portable seeder from `@webflix/core` over `createD1Database(env.DB)` and the KV
  cache, with `@webflix/catalog` and the manifest **read back from the bucket**, so the seed
  describes exactly what R2 serves (no manifest → external HLS fallback; packaging media later
  and re-running `make cf-dev` picks it up). The demo account is seeded locally by default and
  in production only on request (`--demo`, `make cf-deploy CF_DEMO=1`): its credentials are
  public.

Why not seed from inside the Worker: it would bundle the catalog (and its import-time
validation) into every isolate, need a privileged HTTP endpoint, and put one-off CPU-heavy work
(PBKDF2 for the demo password and PINs, 14 days of synthetic stats) under request CPU limits.
The tooling path runs the same seeder code with none of that, locally and remotely.

**Rate limits locally.** The local environment uses exactly the Node dev mode's relaxed profile
(sign-in and sign-up 60/min, email lookup 300/min, profile selection 60/min; a config test
compares the composed limits with what `apps/api` computes for dev), set as vars in the top
level of wrangler.jsonc, because people, the e2e suites and the conformance suite all share the
demo account and 127.0.0.1 here. The account- and email-keyed policies (`payment`, `auth-email`
10 per 15 min per email, `playback-start` 60/min per account) keep their defaults locally too,
as in dev. Production lists the same keys empty (vars are not inherited; empty means no
override) and runs the strict defaults; a test checks that production's composed limits equal
`DEFAULT_RATE_LIMITS`, and another that every policy the route table names resolves in both
environments. The Worker's own tests run on the strict defaults. To run strict locally:

```sh
make cf-dev CF_DEV_FLAGS="--var WEBFLIX_RATE_LIMIT_AUTH:10/60 --var WEBFLIX_RATE_LIMIT_SIGNUP:5/60 \
  --var WEBFLIX_RATE_LIMIT_EMAIL_LOOKUP:20/60 --var WEBFLIX_RATE_LIMIT_PROFILE_PIN:5/60"
```

Other flags go through `CF_DEV_FLAGS` too, e.g. `--minify` to run the production build.
`node apps/edge/scripts/ops.ts seed --no-media` seeds the external-HLS fallback even when R2
holds packaged media (seed again without it, or run `make cf-dev`, to switch back).

Local niceties: `wrangler dev` prints the Local Explorer API (`/cdn-cgi/local/explorer/...`) to
browse D1, KV, R2 and Durable Objects and query captured logs; the inspector listens on
`localhost:4609`.

### Conformance (`make smoke TARGET=cf`)

Latest run (2026-11-21, round 2), against an isolated local instance (`make cf-dev
CF_PORT=4620 …`, web build served, the fast media profile in its local R2, local rate-limit
profile): **83 checks: 80 passed, 0 failed, 3 skipped**. Skips:

- `media.external-fallback`: every title is packaged; it passes on an external-HLS seed
  (`seed --no-media`).
- `consistency.rate-limit-monotonic`, `ratelimit.strict-defaults`: they need the strict
  limits; both passed in round 1's strict run (`CF_DEV_FLAGS` with the `--var` overrides
  above, `SMOKE_ARGS=--timeout 300000`).

Under strict limits the suite needs `--timeout 300000`: its sign-ups share one client
address's budget (5/min), checks queue on it while their default 120 s clock runs, and which
check times out changes from run to run. This is the suite's pacing on a single-address strict
target, not the Worker's behaviour.

---

## 8. Deploying to a real account (runbook)

Prerequisites: Workers Paid; `pnpm --filter @webflix/edge exec wrangler login`, or in CI
`CLOUDFLARE_API_TOKEN` (Workers Scripts, D1, KV, R2, Queues edit) and `CLOUDFLARE_ACCOUNT_ID`.
Set `env.production.vars.WEBFLIX_PUBLIC_ORIGIN` to the origin users will load (custom domain
or `https://webflix.<subdomain>.workers.dev`); it drives `Secure`/`__Host-` cookies and HSTS.

```sh
make cf-deploy-dry-run   # no account needed: config, assets, the exact bundle, the plan
make cf-deploy           # the real thing
```

`make cf-deploy` (`scripts/deploy.ts deploy`), every step idempotent:

1. **Provision**: check the public origin first (see Routing below; the placeholder stops the
   deploy here), then find or create D1 `webflix`, KV `webflix-cache`, R2 `webflix-media`,
   queues `webflix-jobs` and `webflix-jobs-dlq` (14-day retention); write the D1 and KV ids,
   `workers_dev` and `routes` into `env.production` of wrangler.jsonc (comment-preserving
   edit; commit them). Until then the ids are zero
   placeholders, and the top-level (local) ids are not ids at all, so an accidental
   `wrangler deploy` without `--env production` fails instead of deploying a dev config.
2. Stage static assets for production (adds HSTS) into `dist/production-assets`.
3. `wrangler d1 migrations apply DB --remote --env production --force` (migrations are
   additive and applied before the code that needs them).
4. Media upload (`ops.ts media --target production`). With `R2_ACCESS_KEY_ID` and
   `R2_SECRET_ACCESS_KEY` (an R2 API token) it uses R2's S3 API through the S3 `BlobStore` of
   the Kubernetes mode (`@webflix/adapters-node/s3`, endpoint
   `https://<account>.r2.cloudflarestorage.com` or `R2_S3_ENDPOINT`): the right transport for
   gigabytes. Without them it uses the R2 binding through Wrangler's remote bindings.
5. Seed (`ops.ts seed --target production`), through remote bindings to D1/KV/R2.
6. `wrangler deploy --env production`. The media-token key (`lib/media-keys.ts`): the deploy
   runs `wrangler secret list` first and sets the key with `--secrets-file` only if the listing
   succeeded and shows no key, or failed with Wrangler's specific "Worker not found" (a first
   deploy). Any other failure aborts the deploy: a transient API error must never replace the
   key (every outstanding token would die and the old key could not be recovered). The value
   comes from `WEBFLIX_MEDIA_TOKEN_KEYS` in the environment (your secret manager; required in
   CI), else from the operator's key file `apps/edge/.wrangler/secrets/production-media-token-keys.json`
   (mode 600), else a generated 256-bit key that is written to that file: keep a copy in your
   secret manager, the platform cannot show it again. Later deploys never touch the key.
7. `GET <WEBFLIX_PUBLIC_ORIGIN>/readyz` must answer `ready`. It always runs: a deploy refuses
   to start while the origin is the shipped placeholder (step 1).

**Routing.** Production answers on exactly one hostname, the one in
`env.production.vars.WEBFLIX_PUBLIC_ORIGIN`; `make cf-provision` derives the rest from it. A
custom domain (a zone in the account) gives `workers_dev: false` and a custom-domain route, so
nothing bypasses the zone's WAF and rate-limiting rules through `*.workers.dev`. A first deploy
without a domain is explicit: set the origin to `https://webflix.<your-subdomain>.workers.dev`
and provisioning enables exactly that hostname. The shipped placeholder
(`https://webflix.example.com`) stops a real deploy before it touches the account; the dry run
warns loudly instead.

**Rotating the media-token key** (two phases, safe during gradual rollouts, because no version
of the Worker ever meets a token signed by a key it does not know):

```sh
node apps/edge/scripts/deploy.ts media-key add       # new key appended: every version verifies it
#   wait until that version serves all traffic
node apps/edge/scripts/deploy.ts media-key promote   # the new key signs, the old one still verifies
#   wait the token lifetime (WEBFLIX_MEDIA_TOKEN_TTL_SEC, 6 h)
node apps/edge/scripts/deploy.ts media-key retire    # old key dropped (refused earlier unless --force)
```

Each step reads the current set from `WEBFLIX_MEDIA_TOKEN_KEYS` or the key file, uploads the
next set with `wrangler secret bulk` (a new deployed version) and updates the key file;
`--dry-run` prints the transition without uploading.

The same keys also sign the **known-device cookie** (`__Host-webflix_device` over https: the
session cookie's hardening, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain; a Worker test
checks both). It exempts a browser that signed in to an account before from that account's
per-email sign-in limit (`auth-email`). Old device cookies keep verifying through `add` and
`promote`; after `retire`, a browser whose cookie predates `promote` and that has not signed in
since is unknown once: its next sign-in counts against the per-email limit (10 per 15 min) and
re-issues the cookie with the new key. Retire at a quiet hour if that matters.

**The demo account** (`demo@webflix.dev`, documented password) is not seeded in production
unless asked for: `make cf-deploy CF_DEMO=1` (or `make cf-seed ENV=production CF_DEMO=1`). A
production seed without it leaves an existing demo account in place; delete it from D1 if one
was seeded before.

Operations: Workers Logs persists the Worker's own JSON lines: one `http.request` per request
with the media token replaced by `:token` (on every path, including errors). The platform's
invocation logs and traces are off: both record the full request URL, and media tokens live in
the URL path (HLS-relative URIs need them there), which neither can redact. `make cf-tail`
(`wrangler tail`) streams events live with the **raw URL, tokens included**: operators only,
nothing is stored, and the tokens expire within 6 h; prefer Workers Logs for anything shared.
`/readyz` is public: its database check is shared per isolate for 5 s, so probes cost at most one
D1 query per isolate per 5 s. Rollback:
`wrangler rollback --env production` (migrations are additive, so the previous version runs
on the new schema). Dead letters: dashboard → Queues → `webflix-jobs-dlq`. Media cache: purge
by tag `webflix-media`, or simply re-seed to roll the generation.

**What was exercised and what was not.** Exercised: the dry run end to end (config
validation, production asset staging, the exact minified bundle, the plan); the id and routing
write-back, the derived remote-binding configs, the key decision against Wrangler's recorded
outputs and the rotation steps (unit tests); the S3 upload transport with
the full fast profile (10,710 objects, 1.5 GB in 38 s, idempotent re-run) against miniflare's
experimental local R2 S3 endpoint. Not exercised (no account): resource creation and the
parsing of their live output, remote migrations, remote bindings for seed/upload, the first
deploy with `--secrets-file`, `wrangler secret bulk` for rotations, custom-domain routes, the
readiness check, and the Workers edge cache itself (Range
slicing of loopback requests, `cross_version_cache`, billing of loopback requests). Confidence:
high for the Worker, config and data path (all of it runs locally on the same runtime); medium
for `scripts/deploy.ts provision` (built on documented commands and flags, but their live
output is unverified); medium for the edge cache (documented pattern, behaviour covered by an
emulating test, switchable off with `WEBFLIX_EDGE_CACHE=off` and by removing the `MediaOrigin`
cache flag without code changes).

---

## 9. Differences from the Kubernetes mode

| | Kubernetes / Node | Cloudflare |
| --- | --- | --- |
| Password KDF | scrypt (memory-hard) | PBKDF2-SHA256, configurable cost; hashes do not cross from Node |
| Shared state | Valkey (cache, limits, gate, jobs) | KV (cache), Durable Objects (limits, gate), Queues (jobs) |
| Jobs | Valkey Streams consumer group, `worker` Deployment | Queues push consumer in the same Worker, dead-letter queue |
| Scheduler | timer in the worker (300 s) | Cron Trigger every 5 min |
| Migrations | Kysely migrator (Job / init container) | `wrangler d1 migrations apply` on generated SQL |
| Seeding | `seed` Job | Node tooling over Wrangler bindings (local or remote) |
| Media upload | S3 API | R2 binding locally; S3 API (same adapter) or remote binding in production |
| Media delivery | API process streams from S3 | Gateway authorises; Workers edge cache in front of R2 |
| Client IP for limits | socket or trusted `X-Forwarded-For` | `CF-Connecting-IP` |
| Metrics | Prometheus `/metrics` | none; Workers Logs, traces, analytics |
| Shutdown / draining | `/readyz` 503 while draining | not applicable (no processes) |
| Compression | Node gzips `/api/*` | Cloudflare compresses at the edge |
| Request timing in logs | real | `durationMs` reads 0: Workers time only advances across I/O |
| Request bodies | unlimited by the platform | 100 MB (Free/Pro zone plan); API bodies are capped at 1 MiB anyway |
