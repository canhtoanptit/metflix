# Webflix — Backend guide

How to run the API, configure it, plug in adapters, migrate and seed in every mode, and what the
web app can rely on. Companion documents: `docs/DECISIONS.md` (why things are the way they are),
`docs/RECOMMENDATIONS.md` (browse and personalisation), `docs/CONTRACT_CHANGES.md` (changes to
`@webflix/contracts`).

## 1. Map

| Package | What | Runtime |
| --- | --- | --- |
| `packages/core` | Application services (`createServices`), repository ports, recommendation engine, catalog/popularity caches, mock billing, seeder, jobs and scheduler, in-memory repositories (`@webflix/core/memory`), contract suites and test harness (`@webflix/core/testing`) | portable (Web APIs only) |
| `packages/db` | Kysely schema, migrations (authored once), repositories, SQL search index. Entry points: `@webflix/db` (portable), `@webflix/db/sqlite` (node:sqlite), `@webflix/db/postgres` (pg), `@webflix/db/d1` (D1 binding, portable). Generated D1 SQL in `packages/db/migrations/d1/` | portable + Node-only subpaths |
| `packages/http` | `createApp(container)`: all 46 routes, guard (session, active profile, CSRF, rate limits), media delivery, ops endpoints, OpenAPI + docs UI, security headers, request ids, access logs, Prometheus registry | portable |
| `apps/api` | Node entrypoint: `serve`, `worker`, `migrate`, `seed`; composition of adapters from env | Node |

## 2. Running the API

```sh
pnpm dev                              # API on :4000 + web on :5173 (make dev)
pnpm --filter @webflix/api dev        # API only, restarts on file changes
pnpm --filter @webflix/api start      # node src/main.ts serve (no --watch)
pnpm --filter @webflix/api migrate    # apply migrations and exit
pnpm --filter @webflix/api seed [--force] [--manifest <file> | --no-manifest] [--no-demo]
pnpm --filter @webflix/api worker     # jobs + scheduler only (k8s worker Deployment)
```

**Dev mode needs no setup and no environment variables.** On start it migrates and seeds a
SQLite file in `.data/webflix.sqlite`, keeps blobs in `.data/blobs`, and keeps sessions, rate
limits, stream leases, cache and jobs in process. Delete `.data/` to start from scratch. Seeding
is skipped when catalog, demo account and media manifest are unchanged, so restarts are fast;
changing `@webflix/catalog` re-seeds automatically (and resets the demo account).

**Packaged media.** After `make content` has written `.cache/media/fast/` (or `full/`), restart
the API: it reads blobs straight from that directory (layered under `.data/blobs`) and seeds with
its `manifest.json`, so titles play packaged HLS with subtitles, trick-play, preview clips and
generated artwork. Before that, every title plays an external HLS fallback stream and images
404 (cards carry a `dominantColor` to paint instead).

**Demo account** (from `@webflix/catalog`): `demo@webflix.dev` / `webflix-demo`, Premium plan,
profiles Alex, Jordan (PIN `2468`), Mia (13+) and Kids (7+), with viewing history, My List and
ratings so the home page is full on first load.

**Docs**: `GET /api/docs` (Scalar, served from our origin, no third-party requests) and
`GET /api/openapi.json` (OpenAPI 3.1).

## 3. For the web app

- **Same origin, cookie session.** `createApiClient()` does everything right (credentials, the
  `X-Webflix-Client: web` header on mutations). The session cookie is `webflix_session`
  (`__Host-webflix_session` on https), httpOnly, SameSite=Lax; "remember me" off makes it a
  browser-session cookie. `GET /session` always answers 200 and tells you whether you are signed
  in and which profile is active.
- **Errors** are problem+json with a stable `code`; narrow with `ApiError.is(error, "code")`.
  Notable: `profile_required` (403) on profile routes without an active profile → show "Who's
  watching?"; `profile_pin_required` / `profile_pin_invalid`; `maturity_restricted` (403, carries
  `maturity` and `profileMaturityCeiling`); `stream_limit_reached` (409, carries `limit` and
  `activeStreams` for the "too many screens" page); `subscription_required` (402) when the
  membership has ended; `payment_declined` (402, `declineReason`); `rate_limited` (429,
  `retryAfterSec` and `Retry-After`); `service_unavailable` (503, `Retry-After`) when the
  database cannot be reached: retry. Privileges (below) add `password_required`,
  `profile_unlock_required`, `unrestricted_profile_required` and `demo_account_protected` (all
  403); a rendition above the plan's cap answers `media_quality_restricted` (403).
- **Mock payments** (`MOCK_CARDS` in `@webflix/contracts`): `4242 4242 4242 4242` approves;
  **`4000 0000 0000 0002` → `card_declined`**, **`4000 0000 0000 9995` → `insufficient_funds`**,
  any card with an expiry month in the past → `expired_card`; any other well-formed number
  approves. Sign-up with a declined card creates nothing. A plan change with a declined card
  changes nothing. Memberships renew every 30 days automatically; cancel → `canceling` until
  `currentPeriodEnd`, then `ended`.
- **Profiles.** Up to 5. Kids profiles are capped at 7+. Deleting the last profile answers
  `profile_last_remaining`. Who may add, change or delete one, and who may manage the account,
  is the privilege table below.
- **Privileges** (docs/DECISIONS.md D24). Parental controls are *in use* when any profile is a
  kids profile, has a ceiling below 18+ or is locked (`GET /profiles` → `parentalControls`).

  | Who is acting (the session's active profile) | Profiles | Account (details, plan, card, cancel, devices, sign out everywhere) |
  | --- | --- | --- |
  | No profile (the gate) | Add: without proof while no parental controls are in use, else with `currentPassword`. Change or delete: an unlocked profile freely (loosening needs the password, below); a locked one with its `currentPin` or `currentPassword` | `profile_required` |
  | A kids profile | Switch to any profile (a locked one with its PIN). Change its own name, avatar and settings. Nothing else: `unrestricted_profile_required`, even with the password | `unrestricted_profile_required` |
  | A profile with a lowered ceiling (13+ …) | As at the gate | `unrestricted_profile_required` |
  | A profile without parental controls | As at the gate; its own locked profile without its PIN again | Allowed |
  | Loosening any profile (raising its ceiling, turning kids off, setting, changing or removing a PIN) | `currentPassword`, from any session | — |
  | Signing this device out | — | Always (`POST /auth/logout`) |
  | The demo account | Settings only (`demo_account_protected` otherwise) | Not its sign-in details, plan, card or other devices (`demo_account_protected`); `account.isDemo` is `true` |

  Codes: `password_required` (no password where one is needed), `current_password_invalid` (a
  wrong one), `profile_unlock_required` (a locked profile, from another session, without its PIN
  or the password), `profile_pin_invalid`. `DELETE /profiles/:id` takes an optional body
  `{currentPin?, currentPassword?}`. Every PIN or password check after sign-in counts against
  one per-account budget (`profile-pin`, below); a password sent where none is needed is ignored
  and costs nothing. Setting or changing a PIN signs every other device off that profile: their
  next request answers `profile_required`.
- **Browse.** `GET /browse?view=home|series|movies|new-popular` returns the billboard (first
  batch only; null for new-popular) and 6 rows; follow `nextCursor` for more rows. Each row has
  its first 20 items (Top 10: all 10); follow the row's `nextCursor` with
  `GET /browse/rows/:rowId`. Render rows from `layout` and the items; `kind` is informational.
  Cards carry `viewer.inMyList`/`viewer.rating`, `matchScore` (null for a profile with no
  history yet) and a `badge`. Cursors are opaque and validated (`validation_failed` if tampered,
  search included). Batch and row cursors remember what they served: a row or title that
  appears or disappears between requests never makes the next page skip or repeat one.
- **Playback.** `POST /playback/sessions` → `manifestUrl` (a `/media/{token}/...` URL for packaged
  media, or an absolute external HLS URL), `textTracks`, `trickPlay` (sheet URLs are signed media
  URLs), `markers` (intro/recap/credits), `nextEpisode`, `resumePositionSec`, `maxVideoHeight`
  (the plan cap: the server filters the master playlist and refuses any rendition above it,
  playlist or segment, with `media_quality_restricted`), `heartbeatIntervalSec` (30) and
  `expiresAt` (token expiry, 6 h), `bestVideoQuality` (packaged media only). Send
  `POST /playback/sessions/:id/heartbeat` every interval, on pause and when playback resumes
  after a pause (an interval that began paused earns no watch time), with `state: "ended"` at
  the end; `410 playback_session_ended` means the slot was revoked: stop the player. To leave
  (in the app or on page close), send one `DELETE /playback/sessions/:id` with the final
  position as its body (`{positionSec, durationSec, state}`, exactly a heartbeat) and
  `keepalive`: it records the position and frees the slot in one request, so no final
  heartbeat can arrive after the release and be refused. `404`/`410` on it mean the position
  was not recorded (the slot is free either way). Without a body (an empty or whitespace-only
  one counts as none, whatever `Content-Type` says) it only frees the slot, as before. A playlist request may also answer 410 once the slot is gone; `media_token_expired`
  → create a new session at the current position.
- **Watch time** (what views, Top 10 and Trending count) is credited from position advance
  while playing, bounded by the wall-clock time the session has existed, however many
  heartbeats arrive (docs/DECISIONS.md D16). Heartbeat cost is unchanged: one batch of three
  statements (session, progress, history).
- **Continue Watching** and every play target follow one rule set (docs/RECOMMENDATIONS.md):
  a title is anchored on its latest item watched ≥ 30 s or finished; a finished episode moves
  the series on to the next one; a few seconds of anything (a sampled title, the next episode
  autoplayed before leaving) changes nothing. `DELETE /continue-watching/:titleId` hides it
  until it is watched again for real. Removing a history entry also removes its progress.
- **Badges** are chosen per surface: `top-10` only for titles in the Top 10 row of the view the
  card is on, never in Continue Watching or the ranked row, at most two per list. Every ranked
  card carries `top10Rank` ("#3 on Webflix Today" in previews and detail, badge or not).
- **Video quality**: cards, detail and playback sessions carry `bestVideoQuality` (`sd` / `hd`
  / `full-hd` / `4k`, absent for external fallback media); show
  `effectiveVideoQuality(bestVideoQuality, plan.maxVideoHeight)` with `videoQualityLabel`
  (`@webflix/contracts`), never more than the plan allows.
- **Payment method**: `PUT /account/payment-method` `{payment}` replaces the card (verified like
  sign-up; a decline changes nothing) and answers `AccountDetails`.
- **Signed-out artwork**: `GET /showcase` (no session) lists up to 40 titles rated 13+ at most
  with their versioned `ImageSet`s; it is public and cacheable (`Cache-Control: public`, ETag).
- **Rate limits.** Every 429 is `rate_limited` with `retryAfterSec` and `Retry-After`. Client
  addresses are keyed per subscriber: an IPv6 address by its /64.

  | Policy | Keyed by | Strict (k8s, Cloudflare) | Dev | What counts |
  | --- | --- | --- | --- | --- |
  | `auth` | client address | 10/60 s | 60/60 s | `POST /auth/login` |
  | `auth-email` | email address | 10/900 s | 10/900 s | `POST /auth/login`, unless the browser signed in to that account before (its `webflix_device` cookie) or it is the demo account |
  | `signup` | client address | 5/60 s | 60/60 s | `POST /auth/signup` |
  | `email-lookup` | client address | 20/60 s | 300/60 s | `GET /auth/email-status` |
  | `profile-pin` | account | 5/60 s | 60/60 s | every PIN or password check after sign-in: a PIN for a locked profile (`PUT /session/profile`), `PATCH /account`, and `POST /profiles`, `PATCH`/`DELETE /profiles/:id` when they verify a PIN or the password. Switching to an unlocked profile never counts |
  | `payment` | account | 10/600 s | 10/600 s | card verifications: `PUT /account/payment-method`, a plan change that carries a card |
  | `playback-start` | account | 60/60 s | 60/60 s | `POST /playback/sessions` |

  Dev relaxes the address-keyed limits so e2e suites sharing 127.0.0.1 do not trip them. To
  exercise 429 handling in dev, set e.g. `WEBFLIX_RATE_LIMIT_AUTH=3/60`. Sign-up and sign-in set
  the `webflix_device` cookie (`__Host-` on https; HttpOnly, a year, stateless): it only exempts
  that browser from the per-email limit.
- **Images** are `ImageSet` templates under `/cdn/...` with `?v=<hash>` (immutable caching).
  Without packaged media they 404; `dominantColor` is always set.
- **Diagnostics** (not in production): `GET /titles/:id/popularity` returns a title's stored
  daily counters (baseline and playback views, credited seconds, profiles) for the last 7 days.

## 4. Configuration reference

All configuration is environment variables, validated at start (a bad value fails startup with
every problem listed). **Dev mode needs none.**

### Portable (every mode; parsed by `loadCoreConfig` in `@webflix/core`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEBFLIX_MODE` | `dev` (apps/api only; required elsewhere) | `dev`, `k8s` or `cloudflare` |
| `WEBFLIX_ENV` | `development` | `production` requires real media token keys |
| `WEBFLIX_PUBLIC_ORIGIN` | `http://localhost:5173` | Origin users load the app from; https makes cookies `Secure` and `__Host-` prefixed, and adds HSTS |
| `WEBFLIX_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `WEBFLIX_MEDIA_TOKEN_KEYS` | dev-only key | `id:secret[,id:secret]` (secret ≥ 32 chars); the first signs, all verify (rotation). **Required in production; must be identical on every replica/Worker** |
| `WEBFLIX_MEDIA_TOKEN_TTL_SEC` | `21600` | Media token lifetime |
| `WEBFLIX_SESSION_TTL_DAYS` | `30` | "Remember me" session lifetime |
| `WEBFLIX_HEARTBEAT_INTERVAL_SEC` | `30` | Player heartbeat; stream leases expire after 2 × this + 15 s |
| `WEBFLIX_RATE_LIMIT_AUTH` / `_SIGNUP` / `_EMAIL_LOOKUP` / `_PROFILE_PIN` | `10/60`, `5/60`, `20/60`, `5/60` (relaxed in dev, §3) | `limit/windowSec` |
| `WEBFLIX_RATE_LIMIT_PAYMENT` | `10/600` (every mode) | Card verifications per account (`limit/windowSec`) |
| `WEBFLIX_RATE_LIMIT_AUTH_EMAIL` | `10/900` (every mode) | Sign-ins per email address from browsers the account does not know |
| `WEBFLIX_RATE_LIMIT_PLAYBACK_START` | `60/60` (every mode) | Playback sessions started per account |

### Node (`apps/api`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | Listen port (`serve` and `worker`) |
| `HOST` | all interfaces | Listen address |
| `WEBFLIX_DATABASE_URL` | dev: `sqlite:<repo>/.data/webflix.sqlite`; required otherwise | `postgres://user:pass@host:5432/db` or `sqlite:<path>` / `sqlite::memory:` |
| `WEBFLIX_DATABASE_POOL_MAX` | `10` | Postgres pool size per process |
| `WEBFLIX_BLOB_STORE` | dev: `fs`; else `s3` | `fs`, `memory` or `s3` (see §5) |
| `WEBFLIX_BLOB_DIR` | `<repo>/.data/blobs` | Root of the `fs` store |
| `WEBFLIX_MEDIA_DIR` | dev: `<repo>/.cache/media/fast` or `full` if present | Read-only packaged-media directory layered under the blob store; `none` to disable |
| `WEBFLIX_MEDIA_MANIFEST` | `<media dir>/manifest.json` if present | Manifest used by `seed`; `blob:<key>` reads it from the blob store (k8s: `blob:manifests/media.json`, seeded without media while absent); `none` to seed without packaged media |
| `WEBFLIX_VALKEY_URL` | unset (in-process state) | Valkey for cache, rate limits, stream gate, jobs (§5): `redis://` or `rediss://` |
| `WEBFLIX_VALKEY_PASSWORD` | unset | Overrides the URL's password (URL in config, password from a Secret) |
| `WEBFLIX_VALKEY_KEY_PREFIX` | `webflix:` | Prefix of every Valkey key |
| `WEBFLIX_JOBS_CONCURRENCY` | `4` | Jobs one `worker` process runs at once |
| `WEBFLIX_S3_ENDPOINT`, `_REGION` (`us-east-1`), `_BUCKET` (`webflix-media`), `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_FORCE_PATH_STYLE` (`true`) | | S3 settings for the S3 adapter |
| `WEBFLIX_PASSWORD_HASHER` | `scrypt` | `scrypt` (memory-hard) or `pbkdf2`; the other still verifies and is upgraded on login |
| `WEBFLIX_MIGRATE_ON_START` | dev: `true`; else `false` | `serve` (and `seed`) migrate first |
| `WEBFLIX_SEED_ON_START` | dev: `true`; else `false` | `serve` seeds first (skipped when unchanged) |
| `WEBFLIX_TRUST_PROXY` | k8s: `true`; else `false` | Client IP from `X-Forwarded-For` (rate limits) |
| `WEBFLIX_TRUSTED_PROXY_HOPS` | `1` | Proxies appending to `X-Forwarded-For`; the client is that many entries from the right (client-sent entries are never trusted) |
| `WEBFLIX_HTTP_KEEP_ALIVE_SEC` | `65` | Idle keep-alive lifetime; must exceed the idle timeout of any proxy in front |
| `WEBFLIX_OPS_PORT` | unset (ops endpoints on `PORT`) | Separate listener for `/healthz`, `/readyz`, `/dependencies`, `/metrics`; the public port then refuses them |
| `WEBFLIX_SHUTDOWN_DELAY_SEC` | dev: `0`; else `5` | On SIGTERM, fail `/readyz` and keep serving this long before closing |
| `WEBFLIX_SCHEDULER_INTERVAL_SEC` | `300` | Scheduler tick (stats rollups, daily baseline, cleanup) |
| `WEBFLIX_METRICS` | `true` | Serve `/metrics` |

Tests: `WEBFLIX_TEST_POSTGRES_URL` enables the Postgres runs of the `packages/db` suites.

## 5. Composition and plugging in adapters

Everything is built from ports:

```ts
const services = createServices({            // @webflix/core
  config, repos, search, cache, streamGate, jobs, passwords, mediaTokens, billing, clock, ids, logger,
});
const app = createApp({                      // @webflix/http
  config, services, blobs, rateLimiter, clock, ids, logger,
  readiness, metrics, clientIp, docs, isShuttingDown,  // optional
});
```

### k8s (Node): `apps/api/src/adapters.ts`

Implemented; the deployment itself (Helm chart, kind workflow, measured behaviour) is
documented in `docs/KUBERNETES.md`.

- **Database**: `WEBFLIX_DATABASE_URL=postgres://...` (PostgreSQL 19); a password missing from
  the URL is taken from `PGPASSWORD`.
- **Valkey** (cache, rate limiter, stream gate, job queue): `@webflix/adapters-node/valkey`,
  each passing its `@webflix/core/testing` suite against a real Valkey
  (`pnpm --filter @webflix/adapters-node test:services`). Selected when `WEBFLIX_VALKEY_URL` is
  set (watched by the dependency monitor, not part of readiness: see §7). The job queue is
  Valkey Streams with a consumer group,
  driven by `worker`. **Without Valkey run exactly one replica**: rate limits and stream limits
  are per process (the API logs a `state.in_process` warning in k8s mode).
- **S3** (blob store): `@webflix/adapters-node/s3` (`createS3BlobStore`, AWS SDK v3; static keys
  or the pod's identity), passing `describeBlobStoreContract` against Garage.
- **Processes**: `serve` (Deployment, public port `PORT`; with `WEBFLIX_OPS_PORT` set,
  `/healthz`, `/readyz`, `/dependencies` and `/metrics` move to that port and the public one
  refuses them), `worker` (Deployment; the same ops endpoints on `WEBFLIX_OPS_PORT`, else `PORT`;
  needed only once jobs go through Valkey: with in-process jobs `serve` consumes its own),
  `migrate` (Job), `seed` (Job: `seed --manifest blob:manifests/media.json`, idempotent), and
  `wait [--skip-migrations] [--blobs]` for init containers (blocks until the database is
  migrated and Valkey/the bucket answer).
- **Routing**: send `/api`, `/media` and `/cdn` to the API's public port; the ops port stays
  internal (the chart sets `WEBFLIX_OPS_PORT=4001`). Set `WEBFLIX_PUBLIC_ORIGIN` to the user-facing https origin and
  `WEBFLIX_MEDIA_TOKEN_KEYS` from a Secret (identical in every pod).
- **Shutdown**: SIGTERM → `/readyz` 503 → wait `WEBFLIX_SHUTDOWN_DELAY_SEC` → stop accepting,
  drain in-flight requests → stop jobs → close pools; hard deadline delay + 25 s. Set
  `terminationGracePeriodSeconds` ≥ delay + 30.

### Cloudflare (`apps/edge`)

The same services and app run in workerd on D1; `packages/db/test/workerd/app.test.ts` proves it
(signup, profiles, browse, search, playback, media ranges, heartbeats, kids filtering, ops).
**Implemented** in `apps/edge/src/runtime.ts` (composition) and `apps/edge/src/index.ts`
(`fetch`, `queue`, `scheduled`, Durable Objects, the cached media origin); the design, local
workflow and deployment runbook are in `docs/CLOUDFLARE.md`. The original sketch:

```ts
import { createD1Database } from "@webflix/db/d1";
import { createRepositories, createSqlSearchIndex } from "@webflix/db";
import { createApp } from "@webflix/http";
import * as core from "@webflix/core";

let built: ReturnType<typeof build> | undefined;          // once per isolate: keeps caches warm
function build(env: Env) {
  const config = core.loadCoreConfig(env);
  const clock = core.systemClock;
  const database = createD1Database(env.DB);
  const services = core.createServices({
    config, clock,
    repos: createRepositories(database),
    search: createSqlSearchIndex(database),
    cache: createKvCache(env.CACHE),                       // adapters-cloudflare
    streamGate: createDurableObjectStreamGate(env.STREAMS), // one DO per account
    jobs: createQueuesJobQueue(env.JOBS),
    passwords: core.createPbkdf2PasswordHasher(),
    mediaTokens: core.createMediaTokens(core.createHmacTokenSigner({ keys: config.media.tokenKeys, clock }), clock),
    billing: core.createMockBillingProvider(),
    ids: core.createUuidV7Generator(),
    logger: core.createJsonLogger({ level: config.logLevel }),
  });
  const app = createApp({ config, services, clock, ids: core.createUuidV7Generator(), logger: …,
    blobs: createR2BlobStore(env.MEDIA), rateLimiter: createDurableObjectRateLimiter(env.LIMITS),
    docs: { scriptUrl: "/api/docs/scalar.js" } });           // serve the file from static assets
  return { app, services };
}
export default {
  fetch: (request, env, ctx) => (built ??= build(env)).app.fetch(request, env, ctx),
  async queue(batch, env) {                                   // Queues consumer
    const { services } = (built ??= build(env));
    for (const message of batch.messages) {
      const outcome = await services.processor({ id: message.id, ...message.body,
        attempt: message.attempts, enqueuedAt: message.timestamp.getTime() });
      if (outcome.action === "ack") message.ack(); else message.retry({ delaySeconds: outcome.delaySec });
    }
  },
  scheduled: (_controller, env, ctx) => ctx.waitUntil((built ??= build(env)).services.scheduler.tick()),
};
```

Notes for that work:
- Build services **once per isolate** (module scope): the catalog snapshot and popularity are
  memoised in memory for 30–60 s, then read from KV; rebuilding per request would read KV every
  time.
- `clientIp` defaults to `CF-Connecting-IP`, which is right on Workers.
- `Date.now()` only advances across I/O in Workers; nothing measures elapsed CPU with it.
- PBKDF2 at 600k iterations is ~40 ms of CPU per sign-in: Workers Paid.
- The docs bundle (`@scalar/api-reference/dist/browser/standalone.js`) must be in the static
  assets at `/api/docs/scalar.js`, or pass `docs.serveScript` that fetches it from `ASSETS`.
- `/metrics` is Node-only; do not pass `metrics` on Workers.

## 6. Database, migrations and seeding

### Dialects

| Mode | Dialect | Factory |
| --- | --- | --- |
| dev, tests | SQLite via built-in `node:sqlite` (WAL, foreign keys on) | `createSqliteDatabase({ path })` from `@webflix/db/sqlite` |
| k8s | PostgreSQL via `pg` | `createPostgresDatabase({ connectionString, maxConnections })` from `@webflix/db/postgres` |
| cloudflare | D1 | `createD1Database(env.DB)` from `@webflix/db/d1` |

One repository implementation serves all three; the repository contract suite (28 tests,
`describeRepositoryContract` in `@webflix/core/testing`) passes on memory, SQLite, Postgres 19
and D1 in workerd. A test introspects SQLite and Postgres schemas and asserts identical tables,
columns, type families and nullability.

### Migrations

- Authored once in TypeScript: `packages/db/src/migrations/NNNN_name.ts`, listed in
  `migrations/index.ts`. Never edit a shipped migration; add one.
- Node: `webflix-api migrate` (Kysely migrator, lock table; safe with concurrent pods). Dev runs
  it on start.
- **D1: run `pnpm --filter @webflix/db generate` after changing migrations**; it writes
  `packages/db/migrations/d1/NNNN_name.sql` (a test fails while they are stale). Point wrangler at
  them: `"d1_databases": [{ "binding": "DB", "database_name": "webflix", "database_id": "…",
  "migrations_dir": "../../packages/db/migrations/d1" }]`, then
  `wrangler d1 migrations apply webflix --local` (dev) or `--remote`. The workerd test suite
  applies exactly these files.

### Seeding

`services.seeder.seed({ catalog, demoAccount, manifest }, { force })` is portable. It writes the
catalog atomically, upserts notifications, rebuilds the search index, writes 14 days of synthetic
title stats and resets the demo account. It is idempotent (skips when the input hash is
unchanged). The hash includes a seed format version: format 3 (this change) stores each packaged
asset's nominal best height and measures demo progress on the playable stream, so every
deployment re-applies the seed once (it resets the demo account, as any re-seed does).

- dev: automatic on `serve` (and `node apps/api/src/main.ts seed`).
- k8s: `seed` Job after `migrate`, with `--manifest` pointing at the manifest uploaded with the
  media (or `WEBFLIX_MEDIA_MANIFEST`).
- cloudflare: the same seeder runs in Node over the Worker's bindings (Wrangler's
  `getPlatformProxy`: local miniflare state, or the real account through remote bindings), with
  `@webflix/catalog` and the manifest read back from R2: `make cf-seed` (`ENV=production`). It
  needs fewer than ten D1 round trips (four of them large batches) and a PBKDF2 hash per demo
  password and PIN. Why not from inside the Worker: docs/CLOUDFLARE.md §7.

A run that finds the same inputs still checks the demo account: if its sign-in details,
membership or profiles differ from the seed (a takeover, a manual edit), it resets the account
and logs `seed.demo_restored` with what drifted (`SeedResult.demoRestored`). The API refuses
those changes on the demo account (`demo_account_protected`, §3).

Unpackaged media falls back to external HLS: an asset's own `externalHlsUrl`, else the stream of
another asset cut from the same source film, else the catalog's first stream. With a manifest,
packaged assets play from the blob store.

### D1 specifics (summary; see DECISIONS.md D2–D3)

- No interactive transactions: atomic writes are single repository methods implemented as one
  `D1Database.batch()`. `db.transaction()` throws on D1 by design.
- ≤ 100 bound parameters per statement, enforced on **every** dialect; bulk inserts are chunked.
- LIKE patterns ≤ 50 bytes: suggestion tokens keep at most 47 UTF-8 bytes, cut between code
  points, on every dialect (DECISIONS.md D3).
- Hot paths are bounded: a warm browse page is **2 round trips** (session lookup + one batch for
  the profile's library); cold ≤ 4; title detail 2; search ≤ 4; a heartbeat, and a release that
  carries the final position, write in **one batch**. Asserted in
  `apps/api/test/app.test.ts` (SQLite) and `packages/db/test/workerd/app.test.ts` (D1).
- FTS5 works on D1 (search index); foreign keys are enforced (profile deletion cascades).

## 7. Operations

- `/healthz`: liveness, no dependencies. `/readyz` (Node, `apps/api/src/ops.ts`):
  process-local readiness only: `starting` (503) until this process has reached the database
  with the schema current and Valkey (when configured), `draining` (503) on shutdown,
  `unresponsive` (503) if the event loop is wedged; a shared dependency failing later does not
  make it unready (requests needing it answer 503 with `Retry-After` instead). `/dependencies`:
  each dependency's last probe (every 5 s), 503 when any is down; also exported as
  `webflix_dependency_up{dependency}` and `webflix_dependency_probe_seconds{dependency}`.
  In k8s these live on `WEBFLIX_OPS_PORT`; the public listener answers 404 for them, whatever
  the spelling (percent-encoded, dot segments).
- `/metrics` (Node): `webflix_http_requests_total{method,route,status}`,
  `webflix_http_request_duration_seconds{method,route}` (route = matched pattern, never the raw
  path), `webflix_db_round_trips`, `process_resident_memory_bytes`, `nodejs_heap_used_bytes`,
  `process_uptime_seconds`, `nodejs_eventloop_lag_p99_seconds`.
- Logs: one JSON object per line on stdout (`level`, `time`, `msg`, `service`, `component`,
  `mode`, `requestId`, ...). One `http.request` line per request (health/metrics at debug).
  Every line that carries a path (`http.request`, `http.unhandled_error`,
  `http.dependency_unavailable`) logs media paths as `/media/:token/vod/...`, never the token.
  A database that cannot be reached answers 503 `service_unavailable` with `Retry-After: 5` and
  logs `http.dependency_unavailable` with the cause (DECISIONS.md D33). A PostgreSQL shutdown or
  failover fails the requests in flight that way; it never ends the process (D41).
- Jobs published by the scheduler every tick (5 min): `stats.baseline-day`, `stats.rollup-day`
  (today and yesterday), `playback.cleanup` (sessions older than 30 days; log
  `playback.cleaned_up {deleted}`), `sessions.cleanup` (expired sign-ins, 500 per job, repeated
  while full; log `sessions.cleaned_up {deleted, more}`).
  A gateway in front logs its own lines: on kind, Envoy logs `/media/[redacted]`
  (docs/KUBERNETES.md §3); any other gateway must be configured likewise.
- Every response carries `X-Request-Id` (an incoming valid one is reused) and security headers
  (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, COOP/CORP same-origin, a restrictive
  CSP, HSTS on https). API JSON is `Cache-Control: no-store` with `Vary: Cookie`, except
  the public showcase (`GET /api/v1/showcase`: `public, max-age=300,
  stale-while-revalidate=86400`, ETag, no `Vary: Cookie`); `/cdn` is immutable; media is
  `private` and never cached beyond its token.
- The Node server gzips `/api/*` responses (a browse batch: 73 KB → 5 KB).

## 8. Tests

```sh
pnpm --filter @webflix/core test        # services (memory repos), engine, contract suites on memory
pnpm --filter @webflix/db test          # SQLite (node) + D1 (workerd): repositories, search, migrations, full API on D1
pnpm --filter @webflix/db test:postgres # same suites on PostgreSQL 19 in Docker (container webflix-be-pg-test, port 4141)
pnpm --filter @webflix/http test        # HTTP journeys through the typed client (memory repos)
pnpm --filter @webflix/api test         # Node composition on SQLite: query budgets, docs bundle, live catalog smoke test
```

`@webflix/core/testing` exports `createTestServices()` (memory ports, manual clock, fixture
catalog with a demo account) and the fixture catalog/manifest for other packages' tests.
