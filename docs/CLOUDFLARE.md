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
that date. Milestone 2 (§10) was wired and measured on 2026-11-22 with the same versions.

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
| `EventSink` (milestone 2) | **R2**: the event lake, gzip NDJSON objects under `events/dt=…/hh=…/`, written by the queue consumer | The canonical store of behaviour in every mode (blueprint M2 §6.2); R2 directly, never through the media edge cache. §10. |
| `EmailSender` | **D1 outbox** locally (`email_outbox`, read back by the mailbox API from any isolate); **Resend over HTTP** in production | No SMTP client on Workers; the outbox keeps local mail visible across isolates and restarts. |
| `PaymentProvider` | the **fake provider** locally (state in D1, form at `/_pay/*`); **Stripe** in production (fetch + Web Crypto) | Provider events are verified, recorded in D1, then processed by the queue consumer; reconciliation runs on the Cron Trigger. |
| `RecommendationStore` | **KV** `RECS` for per-profile lists, **D1** for models and neighbours | A page reads its lists in one KV read, no D1 round trip; runs are imported from outside the Worker (§10.4). |
| `IdentityProvider`, `StaffVerifier` | the **development issuer** mounted at `/dev-idp/*` locally (single use kept in D1); Google, Apple and a configured staff issuer in production | §10.1. |

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
   ├─ /api/docs/scalar.js ─► static assets (excluded from run_worker_first)
   ├─ /dev-idp/*  ─► Worker: the development OpenID issuer (never in production: 404)
   └─ /_pay/*     ─► Worker: the fake provider's payment form (never in production: 404)

POST /api/v1/webhooks/payments/{provider} ─► verify signature ─► D1 provider_events ─► Queues
POST /api/v1/events ─► validate, enrich ─► Queues ─► queue() ─► R2 events/… (the lake)
Cron */5 ─► scheduled() ─► Queues ─► queue() ─► job handlers (D1, KV, R2): rollups, cleanups,
            playback expiry + outbox drain, privacy sweep, billing reconciliation, …
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
| `GET /api/v1/browse` (warm isolate) | 2 | 0 | 0 | 0 (1 `RECS` read once a model serves the profile) | 0 |
| `GET /api/v1/titles/:id` | 2 | 0 | 0 | 0 | 0 |
| `GET /api/v1/search` | 4 | 0 | 0 | 0 | 0 |
| `POST /api/v1/auth/login` | 4 | 1 (rate limit) | 0 | 0 | 1 (sign-in email / server event job) |
| `POST /api/v1/playback/sessions` | 6 | 2 (rate limit, acquire) | 0 | 0 | 0 |
| `POST …/heartbeat` (every 30 s) | 3 | 1 (renew) | 0 | 0 | 0 |
| `GET …/master.m3u8` | 1 | 1 (slot check) | 1 | 0 | 0 |
| `GET …/seg_N.m4s` | 0 | 0 | 1 (edge-cache miss only); 2 for the first segment of an asset in an isolate (the plan-cap rendition map reads the master playlist, memoised 10 min) | 0 | 0 |
| `GET /api/v1/session` (milestone 2: experiment assignments) | 3 | 0 | 0 | 0 | 0 |
| `POST /api/v1/events` (a batch, with consent) | 4 | 2 (device and account limits) | 0 | 0 | 1 |

Milestone 2's wiring (§10) moved no row: the table was measured before and after it on the
same commit. Two rows differ from the milestone 1 table because the areas changed them before
the wiring (sign-in now publishes one job; starting playback reads one more D1 row); the
budgets test counts the `RECS` namespace too, and the browse read with a served model is
asserted by `test/personalisation.test.ts`. The lake is written by the consumer, never in the
request: an event batch costs one queue message (3 Queues operations per 64 KB) and, in the
consumer, one R2 write.

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
  from a Node mode to Cloudflare needs those users to sign in once on Node running with
  `WEBFLIX_PASSWORD_HASHER=pbkdf2` first (the sign-in rehashes the password; there is no
  password reset). Profile PINs are not rehashed that way: a PIN set on Node must be removed
  with the account password ("Forgot PIN?") and set again.

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
make cf-lake-pull    # (dev server stopped) the event lake out of R2 into CF_RECS_STORE
make cf-recs-push    # (dev server stopped) a scored run from CF_RECS_STORE into R2, pointer last
make cf-recs-import  # (dev server stopped) import the published run into D1 and KV, from Node
make cf-recs-status  # the model the Worker serves and the last import
make cf-export-events # (dev server up) pending exports: webflix-recs export-events, results posted
make cf-erase        # (dev server up) pending erasures: webflix-recs erase, written back, confirmed
make cf-compact      # (dev server up) compact the local lake's closed hours, written back
```

`make cf-dev` from a fresh clone: install (if needed) → `.dev.vars` with every secret
wrangler.jsonc requires (random per-clone media-token and pseudonym keys, provider credentials
empty; an existing file is only completed, never changed) → web build (turbo-cached; if a work-in-progress edit breaks it, the last
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
directory in `<CF_STATE>/dev-server.json`, and fires the Worker's Cron Trigger on the schedule
wrangler.jsonc declares (`*/5`, at the same UTC minute boundaries as the platform):
`wrangler dev` never fires Cron Triggers by itself (observed: no tick in 12 minutes across three
boundaries), and without them the periodic jobs of milestone 2 (playback outbox drain, privacy
sweep, billing reconciliation) would never run locally. `CF_CRON=off` leaves only `make cf-cron`.
With `CF_JOBS_EVERY=<seconds>` it also runs the pipeline's privacy jobs when something is pending
(§10.4).

`make cf-stop` signals only that recorded runner while it is still alive, still `scripts/dev.ts` and still running in `apps/edge`; without a valid
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
(the values are in docs/BACKEND.md §3: `auth`, `signup`, `email-lookup` and `profile-pin`, the
budget of every PIN or password check, are raised; a config test compares the composed limits
with what `apps/api` computes for dev), set as vars in the top level of wrangler.jsonc, because
people, the e2e suites and the conformance suite all share the demo account and 127.0.0.1 here.
`payment`, `auth-email` and `playback-start` keep their defaults locally too, as in dev.
Production lists the same keys empty (vars are not inherited; empty means no override) and
runs the strict defaults; a test checks that production's composed limits equal
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

Latest run recorded here (2026-11-22, after the export job moved to the pipeline), with the
suite as it stood that day (131 checks; source fingerprint `72f18f7b` of `tools/smoke/src`),
against `make cf-dev` from a fresh state directory on :8787 (web build served, the fast media
profile in its local R2, local rate-limit profile), run the way the suite asks a conformance
deployment to be run, with the pipeline's privacy jobs on a loop (§10.4):

```sh
make cf-dev CF_CRON_EVERY=30 CF_JOBS_EVERY=10 CF_DEV_FLAGS="--var WEBFLIX_DELETION_COOLING_OFF_SEC:30"
make smoke TARGET=cf
```

**131 checks: 123 passed, 0 failed, 5 skipped, 3 known findings that now pass**, in 172 s.
`privacy.export` passed in 5.7 s (its events extracted by `webflix-recs export-events` through
the loop) and `privacy.deletion.erasure` in 59 s. Every milestone 2 area it covers passed on the
Worker: sign-in and linking through the development issuer, the fake provider's member journey,
trials, dunning, provider events delivered twice, out of order and after an outage, privacy
(consent, export, deletion and erasure), the staff API's roles and audited support actions.
Skips:

- `media.external-fallback`: every title is packaged; it passes on an external-HLS seed
  (`seed --no-media`).
- `consistency.rate-limit-monotonic`, `ratelimit.strict-defaults`: they need the strict
  limits; both passed in round 1's strict run (`CF_DEV_FLAGS` with the `--var` overrides
  above, `SMOKE_ARGS=--timeout 300000`).
- `billing.promo-code.applied`: no route, seed or setting creates a promo code for the fake
  provider (the suite's finding M2-F1, billing).
- `experiments.recommendation-status`: no run imported on a fresh state (`make cf-recs-import`
  imports one). The home page's policy label is `learned:<run>` only when a fresh personal list
  of the served run ranked the page, `neighbours:<run>` when only the run's neighbours helped
  (a profile the run never saw), and `rules` otherwise.

The suite's known findings M2-F3, M2-F4 (billing) and M2-F5 (identity) passed: fixed since.
Earlier runs the same day: 130 checks (`16399cc6`, export still inline): 123 passed, 0 failed,
5 skipped, 2 expected failures; 116 checks (`1a39870d`): 111 passed, 0 failed, 4 skipped, 1
expected failure.

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
Set `WEBFLIX_EMAIL_FROM` to an address on a domain verified with the email provider.

Milestone 2 makes production a subscription product, so a deploy needs the provider
credentials. Export them from your secret manager before the first deploy (later deploys never
touch a secret that is set; change one with `wrangler secret put <NAME> --env production`):

| Secret | What | Where it comes from |
| --- | --- | --- |
| `WEBFLIX_MEDIA_TOKEN_KEYS` | media-token keys | generated on the first deploy (or the environment, or the key file); rotation below |
| `WEBFLIX_PSEUDONYM_KEY` | key of the pseudonymous subject keys in the lake and the recommendation store | generated on the first deploy into `apps/edge/.wrangler/secrets/production-pseudonym-key.json` (mode 600; keep a copy); **never rotate**: a new key orphans every subject key already in the lake and the store |
| `WEBFLIX_EMAIL_HTTP_API_KEY`, `WEBFLIX_EMAIL_WEBHOOK_SECRET` | Resend's API key; the signing secret of its webhook (`POST /api/v1/webhooks/email/resend`) | the environment |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | live keys (a test key is refused in production); the signing secret of the endpoint you register in Stripe for `<origin>/api/v1/webhooks/payments/stripe` | the environment |

The deploy reads `wrangler secret list` before it changes anything, and stops with the list of
credentials that are neither set nor in the environment. It also runs the Worker's own config
validation on the production vars first: a deploy whose Worker would answer every request with
503 (`config.invalid`) stops there. The staff API stays closed until you set
`WEBFLIX_STAFF_VERIFIER=oidc` and `WEBFLIX_STAFF_ISSUER` (your Keycloak realm, https). Google
and Apple sign-in are offered once their clients are configured: the client ids as vars, the
client secret / private key with `wrangler secret put` (they are not in `secrets.required`,
which would make them mandatory; see §10.2).

```sh
make cf-deploy-dry-run   # no account needed: config, assets, the exact bundle, the plan
make cf-deploy           # the real thing
```

`make cf-deploy` (`scripts/deploy.ts deploy`), every step idempotent:

0. **Check**: the release name (`--release`, `make cf-deploy CF_RELEASE=…`; default the commit,
   `-dirty` for a changed tree) and the Worker's config validation on the production vars.
1. **Provision**: check the public origin first (see Routing below; the placeholder stops the
   deploy here), then find or create D1 `webflix`, KV `webflix-cache` and `webflix-recs`, R2
   `webflix-media`, queues `webflix-jobs` and `webflix-jobs-dlq` (14-day retention); write the
   D1 and KV ids,
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
6. `wrangler deploy --env production --var WEBFLIX_RELEASE:<release>`, with `--secrets-file`
   holding what the secrets plan (taken right after provisioning, before migrations) sets. A
   secret is set only if `wrangler secret list` succeeded and does not show it, or failed with
   Wrangler's specific "Worker not found" (a first deploy). Any other failure aborts the deploy:
   a transient API error must never replace a key (every outstanding media token would die, or
   every subject key would be orphaned, and the old key could not be recovered).
   `--secrets-file` is additive: secrets it omits stay on the Worker. The media-token key
   (`lib/media-keys.ts`) comes from `WEBFLIX_MEDIA_TOKEN_KEYS` in the environment (your secret manager; required in
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
validation, production asset staging with Stripe's CSP sources, the exact minified bundle, the
secrets plan and the release name, the plan); the id and routing
write-back, the derived remote-binding configs, the key decision against Wrangler's recorded
outputs and the rotation steps (unit tests); the S3 upload transport with
the full fast profile (10,710 objects, 1.5 GB in 38 s, idempotent re-run) against miniflare's
experimental local R2 S3 endpoint. Not exercised (no account): resource creation and the
parsing of their live output (the second KV namespace included), remote migrations, remote
bindings for seed/upload and for the recommendation importer, the KV REST bulk API with a real
token, the first deploy with `--secrets-file` against `secrets.required`, `wrangler secret bulk` for rotations, custom-domain routes, the
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
| Metrics | Prometheus `/metrics` | none; Workers Logs and analytics (invocation logs and traces are off, §8) |
| Shutdown / draining | `/readyz` 503 while draining | not applicable (no processes) |
| Compression | Node gzips `/api/*` | Cloudflare compresses at the edge |
| Request timing in logs | real | `durationMs` reads 0: Workers time only advances across I/O |
| Request bodies | unlimited by the platform | 100 MB (Free/Pro zone plan); API bodies are capped at 1 MiB anyway |
| Email (milestone 2) | in-memory mailbox (dev), Mailpit over SMTP (kind) | D1 outbox locally; Resend over HTTP in production |
| Payment webhooks | in-process queue / Valkey Streams worker | the Worker's webhook route → D1 → Queues → the same Worker's consumer |
| Event lake | filesystem (dev), S3 (k8s) | R2, written by the queue consumer |
| Recommendation store | SQLite / PostgreSQL | KV for per-profile lists, D1 for models and neighbours |
| Recommendation import | `node apps/api/src/recs.ts import`, a CronJob | `make cf-recs-import` from Node (KV REST bulk API in production); not inside the Worker beyond a few hundred profiles |
| Batch jobs (compaction, training, scoring) | `make recs`, CronJobs on the `webflix-recs` image | outside Workers against R2; locally `make cf-lake-pull` / `cf-recs-push` move objects in and out |

---

## 10. Milestone 2 on Cloudflare

`make cf-dev` carries the whole of milestone 2 with every piece of state in a binding: a new
member signs up through the development issuer, checks out with the fake provider, becomes
entitled when the provider's event is processed by the queue consumer, plays, has their events
land in R2 as lake objects, exports and deletes their data, and is served a recommendation run
imported from outside the Worker; the Worker can be stopped and started in between (what that
does and does not keep is in §10.5). Driven over HTTP on 2026-11-22 from a clean state
directory, and by the conformance suite (§7).

### 10.1 What runs where

| Area | Local (`make cf-dev`) | Production (`env.production`) |
| --- | --- | --- |
| Consumer sign-in | the development issuer this Worker mounts at `/dev-idp/{google,apple}`, called in process by the relying party; codes are single use across isolates (D1 claims table), sealed with a secret derived from the media-token key every isolate has | Google and Apple once their clients are configured; `/dev-idp` answers 404 |
| Email | D1 outbox (`WEBFLIX_EMAIL_SENDER=outbox`): `email_outbox`, read back by `GET /api/v1/diagnostics/mailbox` from any isolate | Resend's REST API (`http`), bounces on `POST /api/v1/webhooks/email/resend` |
| Payments | the fake provider: state in D1, its form at `/_pay/*`; its webhooks are delivered in process to the receiver, which verifies them, records them in D1 (`provider_events`) and enqueues `billing.provider-event` | Stripe: the same receiver at `POST /api/v1/webhooks/payments/stripe` → D1 → Queues; the SPA's CSP gains Stripe.js's origins (and only then: `scripts/lib/security-headers.ts`) |
| Event lake | R2 `events/dt=…/hh=…/{uuid}.ndjson.gz`, one object per accepted batch, written by the queue consumer; pseudonym key random per clone; exports' events and erasure of lake rows by the pipeline's jobs (`make cf-export-events`, `cf-erase`, or `CF_JOBS_EVERY`) | the same; the jobs run outside Workers against R2's S3 API; the pseudonym key is generated on the first deploy and never replaced |
| Recommendations | KV `RECS` (per-profile lists) over D1 (models, neighbours); runs imported from Node (§10.4) | the same; `webflix-recs` is provisioned, lists are written with the KV REST bulk API |
| Experiments | definitions in D1 through the isolate memo and KV `CACHE` | the same |
| Staff API | tokens from the development issuer's staff realm (`/dev-idp/staff`) | closed (`memory`) until `WEBFLIX_STAFF_VERIFIER=oidc` and `WEBFLIX_STAFF_ISSUER` are set: intended |

The Cron Trigger (`*/5`) publishes 11 idempotent jobs per tick (observed): the stats baseline,
two rollups, playback and session cleanups, and the areas' own: playback expiry and the
playback outbox drain (events), the privacy sweep (events: due erasures, expired exports),
billing reconciliation, identity cleanup and the audit-log sweep (admin). The one queue
consumer runs them and every area's jobs (event batches, provider events, emails, exports,
erasures, recommendation imports).

### 10.2 Configuration

Vars (both sections; a test compares the names):

| Var | Local | Production |
| --- | --- | --- |
| `WEBFLIX_RELEASE` | `local` | empty in the file; `make cf-deploy` passes the commit (`--var WEBFLIX_RELEASE:…`) |
| `WEBFLIX_EVENT_SINK` | `lake` | `lake` |
| `WEBFLIX_EMAIL_SENDER`, `WEBFLIX_EMAIL_FROM` | `outbox`, default | `http`, set it to an address on your verified domain |
| `WEBFLIX_PAYMENT_PROVIDER` | `fake` | `stripe` |
| `WEBFLIX_STAFF_VERIFIER`, `WEBFLIX_STAFF_ISSUER` | `oidc`, empty (the development issuer) | empty (= `memory`, closed), empty |
| `WEBFLIX_RECOMMENDATION_STORE` | `kv` | `kv` |

Secrets: the same seven names in `secrets.required` in both sections (§8 lists them). Wrangler
loads **only** the names listed there from `.dev.vars` (an allowlist; missing ones produce a
warning), so `make cf-dev` writes every one of them: random media-token and pseudonym keys, and
the provider credentials empty, which the config loader reads as unset. To run the Stripe lane
against the local Worker, fill the three `STRIPE_*` lines from `.cache/stripe/stripe.env`, start
with `CF_DEV_FLAGS='--var WEBFLIX_PAYMENT_PROVIDER:stripe'` and stage the matching headers with
`node apps/edge/scripts/ops.ts assets --payment-provider stripe` (not exercised here: no
sandbox was created for this work). Optional secrets (the Google client secret, Apple's private
key) are deliberately not in `secrets.required`, which would make every deploy require them;
locally they cannot come from `.dev.vars` because of the allowlist (pass them with
`CF_DEV_FLAGS='--var …'`), and in production they are set with `wrangler secret put`.

The release name is not read from the environment: `make cf-deploy` names it explicitly
(`CF_RELEASE`, else the commit). The Kubernetes make fragment no longer exports a variable of
this name into the Makefile's recipes: its Helm release name is `WEBFLIX_HELM_RELEASE`
(docs/KUBERNETES.md §9.3).

### 10.3 The queue carries billing and behaviour

One queue serves every job. Measured locally: a member's membership turned `active` 2.2 s after
the first invoice was paid on the fake provider's form, polling only `GET /session` (which never
reads the provider; `GET /billing/checkout/:id` reconciles with it, by billing's design), with
`invoice.paid` marked processed in `provider_events` by the consumer. The 2 s are the local
`max_batch_timeout`; production waits up to 5 s for a batch to fill. Event batches share the
queue with provider events and `max_concurrency: 2` (chosen to protect D1, which event batches
barely touch: the consumer writes them to R2). If behaviour volume grows, a burst of event
batches can delay entitlement; the remedy is a second queue for `events.*` jobs (a routing
`JobQueue` in `adapters-cloudflare`, a second consumer with higher concurrency), not built yet.

### 10.4 Batch jobs, the importer and the privacy jobs, outside Workers

Compaction, training, scoring and analysis run outside Workers against R2 (blueprint M2 §9), and
so do the events part of a data export and the erasure of lake rows (below). Recommendation
runs, locally (the dev server stopped, like every ops command: one runtime per state directory):

```sh
make cf-stop
make cf-lake-pull            # R2 events/ → CF_RECS_STORE (default .cache/recs/cf/store), incremental
#   run the pipeline on that store: services/recs `webflix-recs --store .cache/recs/cf/store …`
make cf-recs-push            # its published run → R2: recs/v={run}/… then recs/current.json last
make cf-recs-import          # publish it into D1 (model, neighbours) and KV (lists), from Node
make cf-dev
```

For a demo with no fresh pipeline run, `make cf-recs-import CF_RECS_DEMO=1` (dev server stopped)
publishes a demo run for the demo account's profiles into the local R2 and imports it the same
way: lists filed under the keys the Worker derives with its `.dev.vars` pseudonym key, labelled
as demo data (run id `*-de00de00`; docs/RECOMMENDATIONS.md, "A demo run"). Local only.

The store directory is the dev mode's filesystem `BlobStore` layout, which the pipeline reads
and writes. In production the pipeline reads and writes R2 itself (its S3 store, R2's S3 API),
and `make cf-recs-import ENV=production` (with `CLOUDFLARE_ACCOUNT_ID` and a
`CLOUDFLARE_API_TOKEN` with Workers KV Storage: Write) imports through Wrangler's remote
bindings for D1 and R2 and the KV REST bulk endpoint for the lists. The importer is the
personalisation service's own (`importRecommendations`), composed in Node on the Worker's
bindings, so it validates the artefacts exactly as the Worker's job would, and it invalidates
the shared model cache in KV: a running Worker serves the new run within its isolate memo
(30 s).

Why outside: inside a Worker every KV `put` is one of the invocation's 1,000 operations to
Cloudflare services (KV has no bulk write binding; the REST bulk write takes 10,000 pairs per
request), a queue consumer has 128 MB of memory for the Parquet shards, and a run of the
simulated pipeline has 89,000 profiles. The staff API's `POST /system/recommendations/import`
queues the in-Worker job only for a run the binding can write in one invocation; a larger one is
refused up front with `recommendation_import_too_large`, whose detail names `make cf-recs-import
(node apps/edge/scripts/ops.ts recs import)`, this importer (the outside importer passes the
REST or binding writer itself, so no such limit applies to it).

Measured: the lake of a journey (7 objects) pulled, a run for its two profiles written by a
stand-in for the pipeline's `score`/`publish` (the pipeline itself was not run on this
machine), pushed, and imported in 73 ms; browse then reported `policy: learned:<run>` with the
imported top picks. `createKvRestBulkWriter` was run against miniflare's Local Explorer API,
which implements the same `PUT …/storage/kv/namespaces/{id}/bulk` with a request schema
generated from Cloudflare's OpenAPI document: 25,001 pairs went in three requests (10,000,
10,000, 5,001), absolute expirations were stored, and a request the API refused made the
writer throw with the API's message. (The emulator took 123 s for those writes: it measures the
request shape, not the platform's speed.)

**The privacy jobs: data exports and erasure.** A member's export reads every event of the
account within 13 months, which no Worker invocation can do (subrequests, CPU), so on Cloudflare
the export is split: the Worker assembles everything but the events and records the request
(`WEBFLIX_EXPORT_EVENTS=batch`, the default here; `inline` is refused at startup), the
pipeline's `webflix-recs export-events` reads the lake, and the operator route
`POST /api/admin/v1/system/privacy/exports/results` folds its output in and finishes the export.
Erasure of an erased member's rows from the lake (raw objects and compacted hours), the
quarantine, datasets and artefacts is the pipeline's `webflix-recs erase`, confirmed with
`POST /api/admin/v1/system/privacy/erasures/confirm`. Both jobs list their work from the staff
API (`GET …/system/privacy/exports`, `GET …/system/privacy/erasures`) with a service token: the
development issuer's `webflix-jobs` client (client-credentials grant at
`{origin}/dev-idp/staff/token`, roles `admin` and `experiments`), as a Keycloak service account
would be on a real deployment.

Locally the pipeline cannot read miniflare's R2, so these targets carry each job's round trip,
**with the dev server up** (R2 is reached through the dev server's own Local Explorer API,
`scripts/lib/explorer-store.ts`, so the state still has one owner):

```sh
make cf-export-events   # GET …/exports → pull events/ → export-events → privacy/export-events/… into R2 → POST …/exports/results
make cf-erase           # GET …/erasures → pull events/, events-quarantine/, privacy/export-events/, recs/
                        #   → erase → rewritten and removed objects into R2 → POST …/erasures/confirm
make cf-compact         # pull events/ → compact → Parquet files and _compaction.json into R2
make cf-dev CF_JOBS_EVERY=10   # the dev server also runs `jobs run` (erase, then export) every 10 s
```

Each is safe to rerun and a no-op with nothing pending (one token request and the list calls).
The pull is an exact mirror of what R2 holds for those prefixes (`recs/` is merged with the
store's own runs) and incremental: a sync record (`<store>/cf-sync.json`, R2's and the store's
etags per key) means an unchanged object is never downloaded twice. The push sends only what
the job changed since the pull: uploads first, a manifest after its data (`_compaction.json`,
`manifest.json`, `recs/current.json` last), deletions last, which is the order the lake's
readers rely on; an object the Worker wrote after the pull is never touched. R2 owns what the
product writes or reads (`events/`, `events-quarantine/`, `privacy/export-events/`, `recs/`);
the store owns the pipeline's working data (`recs-work/`, the erasure plan included), as R2 owns
it on a real account. Keys are confirmed only after the rewritten objects are back in R2 (the
job writes its confirmation bodies to a file, `--confirm FILE`, and this sends them); a
verification failure (exit 5) still writes back what was removed and confirms nothing. One
round trip at a time per store (`<store>/cf-jobs.lock`), on top of the pipeline's own lake
lease. `CF_JOBS_GRACE` (default 0) is the export job's grace: production keeps its 15 minutes
for events still in flight; locally a request is listed only after the Worker's own export job
(queued after any events the member sent before it) assembled it, so the member's events are in
the lake by then.

Why its own loop and not the Cron Trigger's: it runs outside the Worker (a Python process and
the store per round), and must never delay or overlap a tick of `scheduled()`; it is off unless
`CF_JOBS_EVERY` is set, and the next round starts only when the previous one has finished.

Measured on the local Worker (2026-11-22, a fresh state, `CF_JOBS_EVERY=10`, `CF_CRON_EVERY=30`,
cooling-off 30 s; `privacy-roundtrips.ts` in the work's scratch directory):

- **Export**: a member signed up, consented, sent a `title.open` and requested an export; the
  request was listed by the operator route 2.1 s later and completed 10.3 s after the request
  (one loop period). The downloaded document held the account, its profiles and its three
  events, the client event included, every one the member's; the pipeline's two documents were
  deleted from R2 once folded in. The round: pull of 3 objects, the job 0.1 s, 2 uploads, 0.2 s.
- **Erasure**: `make cf-compact` (as if two hours later, so the current hour counted as closed)
  wrote the hour's Parquet file and manifest into R2; the member's key was then in 3 raw objects
  and 1 compacted hour. After `POST /account/deletion` the key was listed 48.9 s later (30 s
  cooling-off and the 30 s tick); the loop's round rewrote the Parquet file without its 3 rows,
  deleted the 3 raw objects (only the member's events), verified, wrote back and confirmed the
  account and profile keys (0.6 s), and the key was no longer listed 3.0 s after it appeared. A
  scan of every object in local R2 (raw lines, Parquet `account` and `profile` columns, export
  outputs) found the key nowhere.
- **Cost per round**: nothing pending: a token and two list calls (tens of milliseconds). With
  work at this lake size: 0.2–1.2 s for an export (most of it the incremental pull), 0.6–0.8 s
  for an erasure; the pipeline itself took 0.1–0.5 s and up to 190 MB. The latency a member sees
  is at most one loop period on top. Pulls grow with the lake: listing is one explorer call per
  1,000 objects, downloads only new objects.

**What this proves and what it does not.** It proves the product's side of both jobs on the
Worker (the operator routes with a service token, the folding in of a verified events file,
confirmation after the rewrite) and the pipeline's jobs on what the Worker wrote, end to end, so
the conformance checks `privacy.export` and `privacy.deletion.erasure` pass on `make cf-dev`. It
does not prove the production path: on a real account the jobs run outside Workers (a container
or any scheduler) with `--store s3://webflix-media` against R2's S3 API (`WEBFLIX_S3_ENDPOINT`
`https://<account>.r2.cloudflarestorage.com`, an R2 API token), call the staff API with a real
issuer's service account, and none of the pulling and pushing exists. Still to show there: the
jobs' reads and writes through R2's S3 API, and the lake lease, which is created with
`PutObject` and `If-None-Match: *`: R2 documents conditional `PutObject` headers as evaluated
atomically against the committed bucket state, with at most one of several create-only writes
succeeding and the others answered `412 PreconditionFailed`
(developers.cloudflare.com/r2/api/s3/api/, read 2026-11-22). The pipeline has verified that
behaviour only against an emulator (moto); locally the lease is on the filesystem store (a hard
link) and this tooling also serialises its rounds.

### 10.5 Verified locally, not shown by local emulation, still to prove on a real account

| Item | Seen locally | Local emulation cannot show | A real deployment must prove |
| --- | --- | --- | --- |
| Sign-up through the development issuer | yes: start → `/dev-idp` → callback → `signed-up`, membership `none` | Google's and Apple's real behaviour (cross-site form post, `SameSite=None`) | Google/Apple clients, their secrets bound at run time while not in `secrets.required` |
| Checkout, provider event → queue → entitlement | yes (2.2 s, `invoice.paid` processed by the consumer) | Stripe webhooks over the internet; Queues' own batching delay (5 s in production) | Stripe live keys, the webhook endpoint and its secret, Stripe's retries against the Worker |
| Periodic jobs on the Cron Trigger | yes: `make cf-dev` fires it every 5 min (a tick at 11:15:00.033 published 11 jobs, run by the consumer); `wrangler dev` alone never does | the platform's scheduler and its propagation (up to 15 min after a deploy) | that ticks arrive every 5 min |
| Events → R2 lake objects | yes (client and server events, gzip NDJSON by receipt hour) | R2's latency and Class A cost | Workers Logs volume, R2 cost at real batch rates |
| Export, deletion, erasure | yes: the export's events extracted by `export-events` and folded in through the operator route; the erased member's raw objects and compacted rows gone from local R2, confirmed after the write-back; account erased, its KV lists deleted | the jobs against R2's S3 API (locally they go through the Local Explorer) | the jobs' S3 access to R2, the lake lease's `If-None-Match: *` on R2, a real issuer's service account, the email through Resend |
| Email | yes (D1 outbox: welcome, receipt, reset-password) | Resend | Resend key, verified domain, bounce webhook |
| Import from outside | yes (local bindings; REST writer against the emulated endpoint) | the real REST API's auth, rate limits and `unsuccessful_keys` | an import of a full-size run with a real token; KV propagation (up to 60 s) |
| State across a restart | yes: session, membership, mailbox, lake, recommendations, stream slots (D1, KV, R2, Durable Objects) | **Queues durability.** miniflare keeps undelivered messages in memory: a batch acknowledged with 202 and followed by a stop 0.5 s later never reached the lake; one stopped after 4.3 s did. Retries waiting on their backoff are lost the same way | that Queues keeps messages across deploys (Cloudflare documents at-least-once delivery) |
| Stripe CSP on the SPA | `_headers` staged with exactly Stripe.js's sources for production, none locally (tests) | the browser's enforcement, Stripe.js at run time, wallets (the chart's header was `payment=()`, which disables the Payment Request API in Stripe's frames; it is now `payment=(self "https://js.stripe.com" "https://*.js.stripe.com")`, which these `_headers` take from the chart: docs/KUBERNETES.md §9.10) | the browser suite with Stripe as provider |
| Production composition | yes, in workerd: Stripe, HTTP email, the lake, staff API closed, `/dev-idp` and `/_pay` 404 (`test/production-config.test.ts`) | | the deploy itself (`secrets.required` with `--secrets-file`) |

What survives a local restart without loss, because it is in D1 before any message is sent:
provider events (and reconciliation repairs a membership whose job was lost), server playback
events (the D1 outbox, drained on the Cron Trigger), due erasures (re-queued by every privacy
sweep). What a local restart can lose: client event batches in their batch window, email jobs,
export jobs (the request then stays pending, and blocks a new one, until staff replay it:
reported to the events owner), recommendation import jobs. Restart the local Worker when it is
quiet, or wait a few seconds after the last request.

### 10.6 Cost drivers added by milestone 2

An accepted event batch costs a gateway request, two Durable Object calls (rate limits), one
queue message (3 Queues operations per 64 KB: $0.40/M beyond the included million) and one R2
Class A write in the consumer ($4.50/M): about $6 per million batches. The web SDK flushes at
most every 5 s, so continuous browsing can reach 720 batches an hour (about $0.0045 per
browsing hour, more than a viewing hour's delivery, §5); playback itself adds little (server
events go through the D1 outbox, one lake object per drain). The lever is writing one lake
object per queue batch instead of per message (up to 10× fewer R2 writes), then a longer flush
interval.

### 10.7 Limits relied on (Cloudflare docs, read 2026-11-22)

- Queues: 128 KB per message, 100 messages and 256 KB per `sendBatch`, consumer batches up to
  100, `max_batch_timeout` 0–60 s, 15 min wall time per consumer invocation, retention up to 14
  days (24 h on Free); messages exhausting `max_retries` go to the dead-letter queue, else are
  deleted; per-message `retry({ delaySeconds })` overrides the batch; at-least-once delivery.
  developers.cloudflare.com/queues/platform/limits/,
  /queues/configuration/batching-retries/, /queues/reference/delivery-guarantees/,
  /queues/platform/pricing/
- Workers KV: 1,000 operations per invocation on Free and Paid (shared with other services,
  e.g. 500 KV reads and 500 R2 reads; a bulk request counts once); 1 write per second per
  key; 25 MiB values; expirations at least 60 s ahead; writes visible elsewhere within 60 s.
  REST bulk write: 10,000 pairs and 100 MB per request, `unsuccessful_keys` to retry.
  /kv/platform/limits/, /kv/api/write-key-value-pairs/,
  /api/resources/kv/subresources/namespaces/methods/bulk_update/
- D1: 1,000 queries per invocation on Paid (50 Free), a batch counts once; 100 bound
  parameters; 100 KB per statement; 30 s per query; 6 simultaneous connections. /d1/platform/limits/
- Workers: 10,000 subrequests (Paid), 128 MB per isolate, CPU 30 s default (5 min max) per
  request and Cron Trigger, 15 min wall time for Cron Triggers and queue consumers, 128
  vars + secrets per Worker (64 Free), 5 KB each. /workers/platform/limits/
- Cron Triggers: UTC; changes take up to 15 minutes to propagate; locally triggered by request.
  /workers/configuration/cron-triggers/
- Durable Object alarms (the stream gate's and the rate limiter's, unchanged by milestone 2):
  at-least-once, retried with exponential backoff from 2 s, up to six attempts.
  /durable-objects/api/alarms/
- Wrangler `secrets.required`: an allowlist for `.dev.vars` locally (missing names warn),
  checked by `wrangler deploy`; `--secrets-file` adds to the existing secrets.
  /workers/wrangler/configuration/, /workers/configuration/secrets/, `wrangler deploy --help`
- R2's S3 API: `PutObject` honours `If-Match`, `If-None-Match`, `If-Modified-Since` and
  `If-Unmodified-Since`, evaluated atomically against the committed bucket state; of concurrent
  create-only writes at most one succeeds, the others get `412 PreconditionFailed` (the
  pipeline's lake lease relies on it). /r2/api/s3/api/
- Stripe.js CSP: docs.stripe.com/security/guide ("Stripe.js").
