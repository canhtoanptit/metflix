# Webflix — Blueprint

Single source of truth for architecture, scope, contracts and conventions. Every contributor (human or agent) reads this first. If reality has to diverge from this document, change the document in the same piece of work and say so in your report.

Webflix is a spike that reproduces the main features of Netflix and proves that **one codebase** can ship to two very different targets:

| Mode | Target | Local story |
| --- | --- | --- |
| `k8s` | Kubernetes via Helm | kind cluster on the developer machine |
| `cloudflare` | Cloudflare serverless (Workers, D1, KV, R2, Durable Objects, Queues) | `wrangler dev` (workerd/miniflare) |
| `dev` | Plain Node process, zero infrastructure | SQLite file + in-memory + filesystem |
| optional | Another cloud provider on a local emulator | only after the two required modes are complete |

A feature is done only when it works in **both** required modes.

---

## 1. Product scope

### 1.1 Must have (MVP)

**Identity & account**
- Marketing landing page (hero with email capture, feature sections, FAQ accordion).
- Sign up: email → password → plan selection → mock payment → first profile. Sign in, sign out, sign out of all devices.
- Plans: Basic (1 stream, 720p), Standard (2 streams, 1080p), Premium (4 streams, 1080p+). Mock billing only; change / cancel / resume plan.
- Account page: membership, plan, devices (active sessions) with revoke, profiles, viewing activity with remove.

**Profiles**
- "Who's watching?" gate, up to 5 profiles per account, avatar picker, kids profile, maturity ceiling, optional 4‑digit PIN lock, per‑profile settings (autoplay next episode, autoplay previews, subtitle language).
- All catalog responses are filtered server‑side by the active profile's maturity ceiling.

**Browse**
- Home with billboard (auto‑playing muted preview) and personalised rows: Continue Watching, My List, Top 10 Today, Trending Now, New Releases, Because You Watched *X*, genre rows, Watch It Again, Webflix Originals.
- Series / Movies / New & Popular views, genre pages with sort.
- Title card with hover preview (video preview, play, add to list, rate, expand).
- Title detail modal (URL‑addressable): hero preview, actions, metadata, episode list with season selector, More Like This, About.
- Search as you type: titles, people, genres; suggestions; empty state.
- My List, ratings (dislike / like / love) — both feed recommendations.
- Notifications dropdown (new arrivals).

**Playback**
- Adaptive HLS streaming with a custom player: play/pause, ±10s, volume, scrubber with buffered range and trick‑play thumbnails, subtitles, quality and speed menus, fullscreen, picture‑in‑picture, full keyboard control, Skip Intro / Skip Recap, next‑episode countdown, episodes panel, resume, end‑of‑title recommendations.
- Progress heartbeats drive Continue Watching and viewing history.
- Concurrent stream limit enforced per plan with a clear "too many screens" screen.
- Streams are protected by short‑lived signed playback tokens.

### 1.2 Stretch (only after MVP is verified in both modes)
- Admin "Studio": upload a video → queue → transcode → publish (k8s: worker Deployment; Cloudflare: Queues + Containers if available locally).
- Optional third deployment mode on a cloud emulator.
- i18n (en + vi).

### 1.3 Out of scope
DRM, real payments, real email delivery, native apps, downloads/offline.

### 1.4 Brand
Webflix is its **own brand**. Netflix is the reference for interaction patterns and quality bar only. Do not use Netflix's name, logo, wordmark, "N" mark, Netflix Sans, artwork, or copy. Do not use any copyrighted third‑party artwork or footage; all media must be freely licensed (and credited) or generated.

---

## 2. Architecture

Hexagonal (ports and adapters). Business logic never imports a runtime, a driver or a cloud SDK.

```
                       ┌────────────────────────────────────────────┐
                       │  apps/web  (React SPA, static assets)      │
                       └───────────────▲────────────────────────────┘
                                       │ same origin: /api, /media, /cdn
┌──────────────────────────────────────┴──────────────────────────────────────┐
│ packages/http      Hono app factory: createApp(container) — routes,         │
│                    validation, auth, error mapping, OpenAPI                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ packages/core      domain types, application services (use cases), PORTS    │
├─────────────────────────────────────────────────────────────────────────────┤
│ packages/db        Kysely schema, migrations, repositories (PG + SQLite)    │
└───────▲──────────────────────────▲──────────────────────────▲───────────────┘
        │                          │                          │
  apps/api (Node)            apps/api (Node)            apps/edge (Worker)
  mode: dev                  mode: k8s                  mode: cloudflare
  SQLite · memory · fs       Postgres · Valkey · S3     D1 · KV · R2 · DO · Queues
```

### 2.1 Ports (defined in `packages/core`)

| Port | dev | k8s | cloudflare |
| --- | --- | --- | --- |
| Database (Kysely) | SQLite file | PostgreSQL | D1 |
| `SearchIndex` | SQLite FTS5 | Postgres FTS + trigram | D1 FTS5 |
| `KeyValueCache` (TTL get/set/del) | memory | Valkey | KV |
| `RateLimiter` | memory | Valkey | Durable Object (the rate‑limit binding is approximate per location and cannot meet the port contract) |
| `StreamGate` (concurrent streams) | memory | Valkey | Durable Object per account |
| `BlobStore` (get w/ range, put, head, list, delete) | filesystem | S3 API | R2 binding |
| `JobQueue` (publish + consumer) | in‑process | Valkey Streams, `worker` Deployment | Queues consumer + Cron |
| `PasswordHasher` | scrypt/argon2 | scrypt/argon2 | WebCrypto‑compatible KDF |
| `Clock`, `IdGenerator`, `Logger`, `TokenSigner` | portable | portable | portable |

Rules:
- Each port ships a **reusable contract test suite** (`describeXxxContract(factory)`) exported from `@webflix/core/testing`. Every adapter must pass it.
- Workers KV is eventually consistent: never use it for read‑after‑write state (session revocation, stream counts). Use D1 or a Durable Object.
- Only Web‑standard APIs in `core`, `http`, `contracts` (fetch, Request/Response, WebCrypto, streams). No `node:` imports there.

### 2.2 Database portability
- Kysely is the only query layer. One repository implementation serves both dialects; dialect differences are isolated in small helpers (JSON, booleans, timestamps, upsert, FTS).
- Text primary keys (UUIDv7 or ULID). Timestamps and JSON are mapped in one place.
- Migrations are authored once. The Postgres and SQLite/D1 schemas must be provably equivalent: the repository test suite runs against both dialects.
- D1 needs SQL migration files for `wrangler d1 migrations apply`; these are generated from the single source, never hand‑maintained in parallel.

### 2.3 Request flow & auth
- SPA and API are always same‑origin. No CORS, no tokens in JavaScript.
- Opaque session cookie (httpOnly, SameSite=Lax, Secure outside plain‑http dev), stored hashed in the `sessions` table. The active profile is bound to the session server‑side (a PIN‑locked profile cannot be selected by header forgery).
- Mutations require a custom header (`X-Webflix-Client: web`) in addition to SameSite as CSRF defence.
- Errors are `application/problem+json` with a stable machine‑readable `code`.
- Auth endpoints are rate limited. Passwords are hashed with a memory‑hard KDF where the runtime allows it; the stored hash is self‑describing (algorithm + params).

### 2.4 Media delivery
- Public immutable blobs (artwork, avatars, preview clips): `GET /cdn/*`, `Cache-Control: public, max-age=31536000, immutable`.
- Protected streams: `GET /media/{token}/vod/{assetId}/...`. The token is in the **path** so relative URLs inside HLS playlists inherit it (works with hls.js and native Safari). Token = HMAC‑signed `{assetId, playbackSessionId, exp}`; verified statelessly for segments, while playlist (`.m3u8`) requests also require the playback session to still hold its stream slot (docs/DECISIONS.md D1); Range requests supported end‑to‑end.
- Media is packaged once, offline, by `tools/media` and uploaded to whichever blob store the mode uses. No transcoding happens in the request path.

### 2.5 Blob layout (one bucket, `webflix-media`)
```
public/img/titles/{titleId}/{kind}-{width}.{avif|webp}     kind: backdrop | card | poster | logo
public/img/episodes/{episodeId}/still-{width}.{avif|webp}
public/img/avatars/{avatarId}.webp
public/previews/{assetId}/preview.mp4
vod/{assetId}/master.m3u8  + renditions, audio, subs/{lang}.vtt, trickplay/*
```
`/cdn/x` maps to `public/x`; `/media/{token}/vod/…` maps to `vod/…`. The query string is ignored when mapping to a key: image URLs carry `?v=<content hash>` from the media manifest, so immutable caching never serves stale artwork after a re-render. Key helpers live in `@webflix/contracts` (`blobKeys`, `cdnUrlForBlobKey`, `artworkToImageSet`).

---

## 3. Repository layout and ownership

pnpm workspace, package scope `@webflix/*`. Internal packages export TypeScript source (no per‑package build step); apps bundle.

```
apps/
  web/                    React SPA
  api/                    Node entrypoint (modes dev + k8s): server, worker, migrate, seed commands
  edge/                   Cloudflare Worker entrypoint: fetch, queue, scheduled, Durable Objects
packages/
  contracts/              zod schemas, DTOs, error codes, route table, typed API client
  core/                   domain, services, ports, contract test suites, in‑memory adapters
  db/                     Kysely schema, migrations, repositories, dialect factories
  http/                   Hono app factory
  adapters-node/          filesystem BlobStore, Valkey + S3 adapters
  adapters-cloudflare/    D1/KV/R2/DO/Queues adapters
  ui/                     design system: tokens, primitives, icons
  player/                 video player component library
  catalog/                seed dataset (titles, people, genres, avatars) + loaders
tools/
  media/                  artwork generation + video packaging CLI (ffmpeg in Docker)
  smoke/                  black-box conformance suite: one base URL in, pass/fail per behaviour out
deploy/
  docker/                 Dockerfiles
  helm/webflix/           Helm chart
  kind/                   cluster config + bootstrap scripts
e2e/                      Playwright suites (run against any mode via BASE_URL)
docs/                     this file, ADRs, runbooks
```

One owner per directory at a time. Never edit outside your assignment; if you need a change elsewhere, make it only when it is additive and unavoidable, and list it in your report.

---

## 4. Technology

Pick the latest **stable** release of each at implementation time (`npm view <pkg> version`); do not guess versions from memory.

- **Language**: TypeScript, `strict` plus `noUncheckedIndexedAccess`. No `any`, no non‑null `!` without a comment explaining why.
- **Tooling**: pnpm workspaces, Turborepo, Biome (lint + format), Vitest, Playwright.
- **API**: Hono, zod, OpenAPI generated from the same schemas, docs UI at `/api/docs`.
- **Data**: Kysely; `pg`; D1; SQLite locally (prefer built‑in `node:sqlite`).
- **Web**: React, Vite, TanStack Query, a typed router with URL‑driven state, Tailwind CSS v4 on CSS‑variable tokens, Radix primitives for accessible overlays, Motion for animation, hls.js. Fonts self‑hosted. No runtime calls to third‑party origins.
- **k8s**: Helm chart with our own templates on official images. Do not depend on Bitnami charts/images (public catalog deprecated in 2025). Prefer **Gateway API** (`HTTPRoute`) with a maintained implementation that runs well on kind — ingress‑nginx was retired in March 2026. Verify the current state of whichever S3‑compatible store you choose (MinIO community images stopped updating in late 2025); the adapter speaks plain S3 so the store is swappable.
- **Cloudflare**: Wrangler (as a devDependency), `wrangler.jsonc`, Workers static assets for the SPA, D1, KV, R2, Durable Objects, Queues, Cron Triggers.

---

## 5. Domain model

`accounts`, `sessions`, `subscriptions` (with the mock card), `profiles`, `avatars`, `avatar_groups`, `titles` (movie | series), `seasons`, `episodes`, `genres`, `title_genres`, `people`, `credits`, `video_assets`, `my_list`, `ratings`, `watch_progress`, `watch_history`, `playback_sessions` (stream activity → stats), `title_stats` (daily view counters → Trending / Top 10), `notifications`, `notification_reads`, search tables, `meta`. Mood tags are a JSON column on `titles` rather than a `tags` table (see `packages/db/src/schema.ts`).

- A title or episode points at a `video_asset`. Several titles may share one asset (the catalog is larger than the set of freely licensed films). A `video_asset` is either `packaged` (in our blob store) or `external` (an absolute HLS URL, used as a fallback when media has not been packaged).
- Maturity levels are ordered: `ALL < 7+ < 13+ < 16+ < 18+`.
- Plans are static configuration, not a table.

---

## 6. HTTP API

Base path `/api/v1`. JSON. The exact schemas live in `packages/contracts` and are authoritative; this table is the intended surface.

**Auth & session**
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/auth/email-status?email=` | landing page routing: sign in vs sign up (rate limited) |
| POST | `/auth/signup` | `{email, password, planId, payment}` (mock) → session cookie |
| POST | `/auth/login` · `/auth/logout` · `/auth/logout-all` | |
| GET | `/session` | bootstrap: account, subscription, plan, profiles, activeProfile |
| PUT · DELETE | `/session/profile` | select `{profileId, pin?}` / clear active profile; only PIN attempts on locked profiles are rate limited (per account) |

**Account**
| GET · PATCH | `/account` | email / password change requires current password |
| GET | `/plans` | |
| PUT · DELETE | `/account/subscription` | change plan / cancel; `POST /account/subscription/resume` |
| PUT | `/account/payment-method` | `{payment}` replaces the card (verified like sign-up; rate limited per account) |
| GET | `/account/sessions` · DELETE `/account/sessions/:id` | devices |

**Profiles**
| GET · POST | `/profiles` | max 5 |
| PATCH · DELETE | `/profiles/:id` | |
| GET | `/avatars` | |

**Browse** (requires an active profile)
| GET | `/browse?view=home\|series\|movies\|new-popular&cursor=` | `{billboard, rows[], nextCursor}`; rows arrive with their first page of items |
| GET | `/browse/rows/:rowId?cursor=` | more items for one row |
| GET | `/genres` · `/browse/genre/:slug?type=&sort=&cursor=` | |
| GET | `/showcase` | public, cacheable: curated titles (≤ 13+) with versioned artwork for signed-out screens |
| GET | `/titles/:id` | detail incl. viewer state (inMyList, rating, progress, matchScore) |
| GET | `/titles/:id/seasons/:seasonNumber/episodes` | with per‑episode progress |
| GET | `/titles/:id/similar` | |
| GET | `/titles/:id/popularity` | daily view counters (diagnostics; not in production) |
| GET | `/search?q=&cursor=` | `{results[], suggestions[], nextCursor}` |

**Library**
| GET | `/my-list` · PUT/DELETE `/my-list/:titleId` | |
| PUT · DELETE | `/ratings/:titleId` | `{value: dislike \| like \| love}` |
| GET | `/continue-watching` · DELETE `/continue-watching/:titleId` | |
| GET | `/history?cursor=` · DELETE `/history/:id` | viewing activity |
| GET | `/notifications` · POST `/notifications/read` | |

**Playback**
| POST | `/playback/sessions` | `{titleId, episodeId?}` → manifest URL, text tracks, trick‑play, markers, resume position, next episode. Errors: `stream_limit_reached` (409, lists active devices), `subscription_required` (402), `maturity_restricted` (403) |
| POST | `/playback/sessions/:id/heartbeat` | `{positionSec, durationSec, state}` |
| DELETE | `/playback/sessions/:id` | optional body: the final heartbeat (recorded, then the slot is freed, in one request) |

**Ops**: `/healthz`, `/readyz`, `/metrics` (Node), `/api/openapi.json`, `/api/docs`.

---

## 7. Content and media

- **Catalog**: ~120 titles (movies and series with seasons/episodes), ~16 genres, people/credits, moods/tags, maturity ratings. A handful are real, freely licensed open films (e.g. Blender Studio open movies) with correct credits; the rest are original fictional titles with well‑written synopses.
- **Artwork** per title: backdrop 16:9, landscape card 16:9 with the title treatment composited in, portrait poster 2:3, transparent title logo; multiple widths in AVIF + WebP; dominant colour and a tiny placeholder hash for blur‑up. Generated deterministically by `tools/media` from freely licensed photography and/or procedural art, with typography that varies by genre. Credits recorded in `docs/CREDITS.md`.
- **Video**: sources are freely licensed films; packaged to HLS (fMP4/CMAF) with an ABR ladder, WebVTT subtitles where available, trick‑play thumbnails, and a short muted‑friendly preview clip. A `fast` profile (short clips, small ladder) keeps first‑run setup to minutes; `full` packages complete films.
- **Offline fallback**: if a source cannot be downloaded, the pipeline still produces working (synthetic) media so every mode boots.
- ffmpeg is **not** installed on the host; it runs in Docker. Packaged output is cached in `.cache/` (git‑ignored) and uploaded per mode.

---

## 8. Running it

| Mode | URL | Command (target shape) |
| --- | --- | --- |
| dev | http://localhost:5173 (API on 4000) | `make dev` |
| k8s | http://localhost:8080 | `make k8s-up` / `make k8s-down` |
| cloudflare | http://localhost:8787 | `make cf-dev`; `make cf-deploy` for a real account |

Other targets: `make setup`, `make content PROFILE=fast|full`, `make test`, `make lint`, `make typecheck`, `make e2e TARGET=dev|k8s|cf`.

The root `Makefile` only defines the generic targets and `-include`s one fragment per area (`tools/media/media.mk`, `deploy/kind/k8s.mk`, `apps/edge/cloudflare.mk`, `e2e/e2e.mk`), so each owner adds targets without editing a shared file.

Use `localhost` (a secure context) rather than custom hostnames so WebCrypto, Secure cookies and media APIs behave the same everywhere.

Demo account seeded in every mode: `demo@webflix.dev` / `webflix-demo` with several profiles and some watch history so the home page is rich on first load.

---

## 9. UX standard

The bar is a shipped consumer product, not a demo.

**Visual language** — dark, cinematic, content‑first. Near‑black surfaces, one confident accent colour, generous imagery, restrained chrome. Type scale, spacing scale, radii, elevation and motion are tokens in `packages/ui`; components never hard‑code values.

**Signature interactions**
- Top navigation: transparent over the billboard, solid on scroll; expanding search field; notifications; profile menu.
- Billboard: full‑bleed backdrop that cross‑fades into a muted preview after a short delay; title treatment; synopsis that collapses while video plays; Play and More Info; mute toggle and maturity badge.
- Row slider: paged with easing, peeking next item, page indicators, arrows on hover, wrap‑around after first page, touch swipe with momentum, lazy‑loaded rows and images.
- Card hover (pointer devices): after a short intent delay the card lifts and expands into a preview with video, actions (play, add to list, rate, expand) and metadata (match %, maturity, duration or seasons, genres). Edge cards expand inward. Touch devices open the detail modal instead.
- Detail modal: grows from the card (shared‑element feel), URL‑addressable, scroll‑locked, closes with Esc / backdrop / back button, focus trapped and restored.
- Top 10 row with oversized rank numerals. Continue Watching with progress bars.
- Player: controls auto‑hide; everything reachable by keyboard (Space/K, ←/→, ↑/↓, M, F, C, Esc, number keys); trick‑play preview on scrub; unobtrusive Skip Intro and next‑episode countdown.
- Optimistic updates for My List and ratings; skeletons that match final layout (no layout shift); graceful empty and error states everywhere.

**Quality gates**
- Responsive from 360px to 4K; rows show 2/3/4/5/6 cards by breakpoint.
- WCAG 2.2 AA: keyboard‑complete, visible focus, correct roles and labels, `prefers-reduced-motion` honoured, captions available.
- Performance: animate only transform/opacity; route‑level code splitting; responsive images with blur‑up; no cumulative layout shift on browse; initial browse JS kept lean.
- Verified by looking at it: UI work is not done until screenshots at mobile, tablet and desktop widths have been captured and critically reviewed against the reference standard.

---

## 10. Engineering standard

- Tests are part of the work: unit tests for services, contract tests for adapters, HTTP integration tests, component tests for non‑trivial UI, Playwright for end‑to‑end flows.
- 12‑factor configuration, validated at startup with zod. No secrets in the repo; development defaults are clearly marked as such.
- Structured JSON logs with a request id. Health and readiness endpoints. Prometheus metrics on Node.
- Containers: non‑root, read‑only root filesystem, resource requests/limits, probes, graceful shutdown.
- Comments explain *why*, not *what*. No dead code, no TODOs left behind without an entry in your report.
- Definition of done: `pnpm typecheck`, `pnpm lint`, `pnpm test` pass for everything you touched, and you have exercised the behaviour for real (not only through unit tests).

---

## 11. Working rules for parallel contributors

Several agents work in this tree at the same time.

- **Never** run `git commit`, `git stash`, `git reset`, `git checkout`, `git clean` or anything else that rewrites the working tree or history. Read‑only git is fine.
- Stay inside your assigned directories. Errors in files you do not own are someone else's work in progress: do not "fix" them; note them in your report.
- Adding a dependency: `pnpm --filter <package> add <dep>`. If it fails because another install is running, wait and retry. Never delete `pnpm-lock.yaml` or `node_modules`.
- Use only the ports assigned to you for anything you start, stop everything you started, and prefix Docker resources with `webflix-`. Never prune or remove Docker resources you did not create.
- Temporary files go in your scratch directory, never in the repo.
- Report format when you finish: what you built; how you verified it (commands and observed results); deviations from this blueprint; known gaps; any file touched outside your assignment.
