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
| `packages/http` | `createApp(container)`: the 80 member routes and the 40-route staff API (every route is implemented; a route registered without a handler would answer `501 not_implemented`, docs/FOUNDATION.md §8.2), guard (session, active profile, staff token and role, CSRF, rate limits), media delivery, ops endpoints, OpenAPI + docs UI, security headers, request ids, access logs, Prometheus registry | portable |
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
- **Billing (milestone 2)**: an account signed up without payment has membership `none`
  (`GET /session` and `GET /account` carry `membership` and `entitlement`; their required
  `subscription`/`plan` show an ended Basic membership). Checkout: `POST /billing/checkout`
  (`requires_setup` + client secret) → the provider's form confirms the card (Stripe's Payment
  Element with `GET /billing/config`'s publishable key, or the fake's form at `/_pay/form?secret=…`)
  → `POST /billing/checkout/:id/confirm` (trial: `processing`; no trial: `requires_payment`, the
  form confirms the first payment, 3-D Secure included) → poll `GET /billing/checkout/:id` until
  `complete` (it reads the provider, so it completes even without webhooks). One trial per
  account and per card. Plan changes: `POST /billing/subscription/preview`, then
  `PUT /account/subscription` with its `previewToken` (charged exactly as previewed). Card
  replacement: `POST /billing/payment-method/setup`, confirm in the form, poll the setup.
  Accounts on milestone 1's mock membership keep milestone 1's behaviour on every route.
- **The fake provider's test cards** (`/_pay`, local modes): every card of `FAKE_CARDS`, by name
  (`visa`) or by Stripe's test number. Trials are one per card fingerprint, and a test card has
  one fingerprint deployment-wide, as a real card would: a suite that needs a card that never
  had a trial asks for a **labelled card**, `<test card>:<label>` (e.g. `visa:run-42`, label
  `[A-Za-z0-9_.-]{1,64}`), in the form's `card` field, its number field or `POST
  /_pay/api/confirm`'s `card`. It behaves exactly like the test card with its own fingerprint;
  the same label again is the same card (no second trial). Promo code `WEBFLIX50` (50% off any
  plan) exists on every fake deployment by default (`WEBFLIX_PAYMENTS_FAKE_PROMOTIONS`).
- **Signed-out artwork**: `GET /showcase` (no session) lists up to 40 titles rated 13+ at most
  with their versioned `ImageSet`s; it is public and cacheable (`Cache-Control: public`, ETag).
- **Rate limits.** Every 429 is `rate_limited` with `retryAfterSec` and `Retry-After`. Client
  addresses are keyed per subscriber: an IPv6 address by its /64.

  This table is the reference for every mode; the other documents point here.

  | Policy | Keyed by | Strict (default: k8s, Cloudflare production) | Relaxed (dev, Cloudflare local, `make k8s-up RATE_LIMITS=relaxed`) | What counts |
  | --- | --- | --- | --- | --- |
  | `auth` | client address | 10/60 s | 60/60 s | `POST /auth/login` |
  | `auth-email` | email address | 10/900 s | 10/900 s | `POST /auth/login`, unless the browser signed in to that account before (its `webflix_device` cookie) or it is the demo account |
  | `signup` | client address | 5/60 s | 60/60 s | `POST /auth/signup` |
  | `email-lookup` | client address | 20/60 s | 300/60 s | `GET /auth/email-status` |
  | `profile-pin` | account | 5/60 s | 60/60 s | every PIN or password check after sign-in: a PIN for a locked profile (`PUT /session/profile`), `PATCH /account`, `POST /session/elevation` (milestone 2, every attempt), and `POST /profiles`, `PATCH`/`DELETE /profiles/:id` when they verify a PIN or the password. Switching to an unlocked profile never counts |
  | `payment` | account | 10/600 s | 10/600 s | card verifications: `PUT /account/payment-method`, a plan change that carries a card |
  | `playback-start` | account | 60/60 s | 60/60 s | `POST /playback/sessions` |
  | `oidc` (milestone 2) | client address | 30/60 s | 300/60 s | `GET /auth/oidc/:provider/start`, both callbacks |
  | `email-send` (milestone 2) | client address | 10/900 s | 120/60 s | `POST /auth/email-verification`, `POST /auth/password-reset` |
  | `email-send-recipient` (milestone 2) | recipient address | 5/900 s | 5/900 s | the same requests, charged by the handler once it knows the address |
  | `events` (milestone 2) | account (signed out: client address), and separately the batch's device | 120/60 s | 600/60 s | `POST /events` (each request charges both keys) |
  | `promotion` (milestone 2) | account | 10/600 s | 10/600 s | `POST /billing/promotions/validate` |

  The relaxed profile raises `auth`, `signup`, `email-lookup`, `profile-pin` and milestone 2's
  `oidc`, `email-send` and `events`, which the e2e
  suites and people sharing 127.0.0.1 and the demo account would otherwise trip. To exercise
  429 handling in dev, set e.g. `WEBFLIX_RATE_LIMIT_AUTH=3/60`. Sign-up and sign-in set
  the `webflix_device` cookie (`__Host-` on https; HttpOnly, a year, stateless): it only exempts
  that browser from the per-email limit.
- **Sign-in, milestone 2 (identity area; docs/BLUEPRINT-M2.md §4).**
  - *Which buttons*: `GET /api/v1/auth/providers` lists the offered issuers (`id`,
    `displayName`, button order; public, cacheable, no database read).
  - *Federated sign-in* is a browser navigation: `GET /api/v1/auth/oidc/{google|apple}/start?intent=signin|link|reauth&returnTo=/path`
    (302 to the issuer; an issuer that cannot be reached sends the browser straight back with
    `?oidc=failed`). The callback redirects to `returnTo` with `?oidc=<outcome>`
    (`OIDC_OUTCOMES`): `signed-in`, `signed-up` (a new account, no membership, no password),
    `linked`, `reauthenticated`, `link-required` (an account has this address but may not be
    linked automatically: sign in to it, then link from Account), `identity-in-use`,
    `cancelled`, `failed` (never more detail; the server logs `identity.oidc_failed` with the
    reason). The callbacks never answer JSON: a request refused before the handler (invalid
    query or form, the `oidc` rate limit) is the same `?oidc=failed` redirect
    (`identity.oidc_refused` in the logs). The transaction is a sealed cookie (`webflix_oidc_<provider>`, `__Host-` on https,
    ten minutes, `SameSite=None` for Apple's cross-site form post).
  - *Linking rule*: an issuer identity is keyed by (issuer, subject). It signs in to an existing
    account by address only when the issuer verified the address **and** the account verified
    it (never the demo account); a new account is created only for an address the issuer
    verified. `intent=link` needs an account holder holding a fresh proof
    (`reauthentication_required` otherwise) and an issuer-verified address; one identity per
    issuer per account. Unlinking needs a fresh proof and refuses the last way to sign in
    (`identity_last_sign_in_method`). A removed identity stays removed (finding M2-F5): an
    unlinked one, or one a password reset dropped, never links itself again, even with both
    addresses verified; its next sign-in is `link-required`, and only `intent=link` (the rule
    above) brings it back. The removal is remembered per (issuer, subject) in
    `identity_removals` until the account is deleted.
  - *Account-holder proof* ("Confirm it's you"): `POST /session/elevation {password}` or a fresh
    sign-in (`intent=reauth`, `max_age=0`, judged by `auth_time`) sets the session's proof for
    five minutes (`GET /session/elevation` → `elevatedUntil`, `methods`). While it lasts it
    stands in for `currentPassword` everywhere one is asked for (account changes, loosening a
    profile, unlocking one); a wrong password is still refused. `Account.hasPassword` and
    `Account.emailVerified` are served on the session.
  - *Accounts without a password* (created through an issuer) store the empty string: no
    password ever signs in to or proves anything for them; they set one with a fresh proof
    (`PATCH /account {newPassword}`).
  - *Email links* (`/verify-email#token=…`, `/reset-password#token=…`: the token is in the
    fragment, never sent to a server) are single-use, stored as SHA-256 hashes, 24 hours and 30
    minutes, and die if the address changes. `POST /auth/password-reset` always answers 204:
    the lookup and the email happen in a job. A completed reset signs out every device, marks
    the address verified, drops issuer identities linked under another address, and sends a
    security alert. Email and password changes alert the (previous) address; a new address must
    be verified again.
  - *Sign-up without a card*: `POST /auth/signup {email, password}` creates the account with no
    membership. Until billing serves `membership: none`, the session presents it as an `ended`
    Basic membership (a stand-in; `GET /account` needs billing's projection).
  - *Local mailbox*: `GET /api/v1/diagnostics/mailbox?to=` (memory or outbox sender, never in
    production) returns the messages and their links, for the suites.
- **Durations**: wherever a title or episode has packaged media, every duration the API returns
  for it is that stream's playable duration, in seconds: `TitleCard.runtimeSec` (movies),
  `EpisodeSummary.runtimeSec`, `NextEpisode.runtimeSec`, `PlaybackSession.durationSec`, and the
  `durationSec` of progress (Continue Watching, detail, history), which is what the player reports.
  The catalogue runtime only stands in for external fallback media. Series cards carry
  `seasonCount`, never minutes; nothing sums episode runtimes. Compute "time left" from
  `positionSec` and `durationSec` (`formatTimeLeft` in `@webflix/contracts`).
- **Previews** (`TitleCard.preview`, so cards, detail and billboard) say what they are: `kind`
  `footage` (a cut of the title) or `motion` (motion art from its key art), and `hasAudio`
  (false: a silent clip, offer no sound control). Both always sent; absent from older servers,
  where they mean footage with audio.
- **Search** accepts a query of up to 2000 characters and searches its first 100, cut between
  code points: a long query is never an error. `SearchResults.query` is what was searched.
- **Notifications**: a profile sees arrivals since it was created as unread, plus the latest
  three from before, already read: a new profile opens with no backlog.
- **Signing devices out** (`POST /auth/logout-all`, every device including the asking one;
  `DELETE /account/sessions/:id`, one device) ends those sessions and frees their screens at
  once: a device that was playing has its next heartbeat refused (`401`), then its playlists
  (`410`), and cannot start again. Segments it already holds a token for stay fetchable until the
  token expires (DECISIONS.md D1); the player stops at the refused heartbeat, at most one
  heartbeat interval (30 s) later. Both need an account holder (§3, Privileges): from the gate
  they answer `profile_required` and sign nobody out.
- **Images** are `ImageSet` templates under `/cdn/...` with `?v=<hash>` (immutable caching).
  Without packaged media they 404; `dominantColor` is always set.
- **Diagnostics** (not in production): `GET /titles/:id/popularity` returns a title's stored
  daily counters (baseline and playback views, credited seconds, profiles) for the last 7 days.

### Behaviour events and privacy (milestone 2 §6)

- **Sending events.** Use `@webflix/telemetry` (`createTelemetry({ app })`): it builds
  `ClientEventInput`s (UUIDv7 ids, the anonymous `deviceId` kept in `localStorage`, a
  `sessionSeq` per app session), batches at most 50 events and 64 KiB per `POST /events`, sends
  with `keepalive` when the page is hidden, retries 429/5xx/network errors with backoff, drops a
  batch the server refuses as invalid, samples impressions and row views per app session, and
  counts an impression once a card has been half visible for a second (`observeImpression`).
  Copy `BrowsePage.policy` and the card's `rowRank`/`rank` into impressions **and** the
  title-open that follows; copy `GET /session`'s experiment assignments with `setDefaults`.
  Call `setEnabled(false)` while a kids or restricted profile is active (the server drops their
  events anyway). Never send identity: the server stamps the subject and a client-supplied one
  is `validation_failed`.
- **`POST /events`** answers `202 { accepted, dropped }`; `dropped` (consent, restricted
  profile, `off` mode) is never an error. All events of a batch come from one device. Limited
  per account (signed out: per address) and per device (`events`). `503` means the batch could
  not be queued: send it again (the lake deduplicates by `eventId`).
- **Consent** is per account; the latest answer wins. `GET /privacy/consent` (signed in or not)
  says what applies and whether to ask (`promptRequired`: opt-in mode and no explicit answer);
  `PUT /privacy/consent` records an answer from a banner or settings (`unrestricted_profile_required`
  from a kids or restricted profile). A signed-out device sends its own banner answer as
  `EventBatch.consent`. `Sec-GPC: 1` is honoured as a withdrawal: in opt-out mode, for a purpose
  the member never answered explicitly, a `gpc` withdrawal is recorded (so server events stop
  too); an explicit later grant wins.
- **Download your data.** `POST /privacy/export` needs a fresh account-holder proof
  (`reauthentication_required`: send the member through `POST /session/elevation`), one export
  at a time (`privacy_request_pending`), not on the demo account. The job builds one JSON
  document (account, profiles, devices, each profile's list, ratings, progress and history,
  consents, privacy requests, every lake event of the account, and each area's own part under
  `areas`: billing's membership and invoices, identity's sign-in methods) and emails the link
  through identity's `data-export-ready` template (the suppression list applies; the link stays
  listed either way); `GET /privacy/requests` lists it with `downloadUrl` until `expiresAt`.
  The link (`GET /privacy/exports/:id?token=`) works only for its account, signed in as the
  account holder; it answers the document as an attachment.
  **Where the events come from** is `WEBFLIX_EXPORT_EVENTS` (§4). `inline` (dev's default): the
  job reads the retention window itself, by the pipeline's reader contract for compacted hours
  (services/recs README, "Compacted hours: the contract for readers": a version 2 manifest's
  Parquet file, only the row groups whose `account` statistics admit the key, never the raw
  objects it covers; a version 1 manifest ignored; an hour re-listed when an object vanishes).
  `batch` (k8s and Cloudflare): the job assembles everything else, keeps it as
  `privacy/exports/{id}.partial.json.gz` and leaves the request `processing`, listed by
  `services.events.staff.pendingExports(limit)` (`{ requests: [{ requestId, accountKey, from,
  to }] }`, `from` = request time minus the raw retention, `to` = the request time;
  `GET /system/privacy/exports`) until a result is recorded. The pipeline's `export-events`
  (services/recs README, "Exports of members' events") writes the member's events under
  `privacy/export-events/{id}/`; `services.events.staff.recordExportResults(document)`
  (`POST /system/privacy/exports/results`) folds a `complete` result in (the file's size and
  SHA-256 verified, each line a lake event of that account inside the window, each `eventId`
  once), deletes both pipeline documents, finishes the export and sends the email; `erased`
  finishes with no events; `deferred` and `failed` keep the request listed; a result for an
  unknown or finished request does nothing. **A batch export stays `processing` until the job
  runs**: the Kubernetes chart schedules it (its lake round, every 5 minutes, every minute in the
  conformance variant: docs/KUBERNETES.md §9.6), and on Cloudflare it runs outside Workers
  (`make cf-export-events`, `make cf-dev CF_JOBS_EVERY=…`). A lost or dead-lettered export job
  never blocks the member: the sweep republishes the job of an export untouched for 15 minutes
  (pending, or processing and not yet waiting for its events) and fails it after a day, which
  frees "one at a time".
- **Delete account.** `POST /account/deletion` (fresh proof, not the demo account) schedules
  the erasure after `WEBFLIX_DELETION_COOLING_OFF_SEC`; `DELETE /account/deletion` cancels it
  meanwhile. The erasure then lists the account's and profiles' pseudonymous keys for the lake's
  compaction (`compact --erase`, `services.events.staff.pendingErasures`), runs every area's
  `eraseAccountData`, frees the streams, deletes the account's export documents and the account
  row (sessions, profiles and their library, membership, consents, linked identities and tokens
  cascade); billing records and the record of the request itself are kept (D-M2-6). An open
  export of the account is cancelled and its documents deleted. The erasure listing
  (`pendingErasures`) is every key not yet confirmed, the limit applied after that filter: an
  erased account's key (its profiles' keys ride on it and are settled when it is confirmed,
  since the lake's compaction drops an account's events by account key) and each restricted
  profile's key. Recording a key twice keeps one entry; recording a confirmed key again re-opens
  it.
- **A profile that becomes restricted** (kids, or a maturity restriction): identity calls the
  seam `forgetProfileBehaviour({ accountId, profileId })`, which queues that profile's
  pseudonymous key for erasure (listed by `pendingErasures`, dropped by `compact --erase`, then
  confirmed). Safe to call twice; the account's other profiles and the account key are never
  touched. From then on the profile produces no events (the privacy rules below).
- **Server events.** Other areas call `emitServerEvent` (never throws; one queue message per
  event, stamped by the consumer with the consent in force at receipt). Playback produces
  `playback.start`, `progress` at each quarter of credited watching, `complete` at 95% or the
  end, and `abandon` (`closed`, `replaced`, `stalled`, `expired`), with ids derived from the session and
  milestone so a repeat is the same event. They are written to the event outbox
  (`event_outbox`) in the same batch as the playback write that produced them, so the playback
  routes answer and cost exactly what they did (no extra round trip, no queue message: apps/edge
  `test/budgets.test.ts`). The `events.outbox` job, published on every scheduler tick, drains
  the outbox to the lake; the read-back and the export drain it first. A session nobody
  released (a killed tab) is ended by the `events.playback-expiry` job (every tick) once its slot
  has lapsed (no report for the lease's lifetime plus a minute, and the gate no longer holds it),
  with one `abandon` (`expired`) in the same batch. Playback start also refuses a title staff
  made unavailable (`not_found`, as its detail page answers), and answers `subscription_required`
  to an account without a membership.
- **The subject's plan** is billing's `currentPlan` (null without an entitled membership: never
  invented). The account behind an export or an erasure is read through identity's
  `getMemberIdentity`, so a member without a membership (sign-up without a card) can export,
  delete, and has its events stamped.
- **The privacy rules and the tests that guard them** (each was checked by breaking the code and
  watching its test fail):

  | Rule | Guard (test) |
  | --- | --- |
  | A kids or restricted profile produces no behavioural events, by any path | `core test/events/privacy-rules.test.ts` (client, server, real playback); `http test/events.test.ts` |
  | Identities come from the server; a client-supplied subject is refused | `ClientEventInput` is closed; `http test/events.test.ts` "refuses a client-supplied identity" |
  | Consent per account, latest stamp wins; nothing kept without a consented purpose | `privacy-rules.test.ts` (consent cases, stamp as of receipt) |
  | `consent.change` is emitted and kept even when everything is withdrawn | `privacy-rules.test.ts` "emits a consent.change server event" |
  | Modes: opt-in withholds, off collects nothing, GPC withdraws | `privacy-rules.test.ts` (modes) |
  | Export needs a fresh proof, completes, is complete, is served only to its account | `core test/events/member-rights.test.ts`, `http test/events.test.ts` |
  | Deletion waits out its cooling-off period, removes what must go, keeps billing records, lists the subject for compaction | `member-rights.test.ts`, `db test/events-erasure.test.ts` |
  | Lake keys are the pipeline's pseudonyms | `core test/events/lake.test.ts`, `services/recs/tests/test_ingested_lake.py` |

### The staff API (milestone 2 §8.3, `/api/admin/v1`)

For the admin console (`createAdminApiClient({ accessToken })`) and for operators.

- **Authentication.** `Authorization: Bearer <access token>` from the staff issuer (the console
  signs staff in with the authorisation code flow and PKCE as client `webflix-admin`; the API
  never sees a staff password). The token must be signed by a key the issuer publishes, with an
  algorithm `WEBFLIX_STAFF_ALGORITHMS` allows, `iss` exactly the configured issuer, `aud`
  containing `webflix-admin-api`, an access token (Keycloak's claim `typ: Bearer`, or header
  `typ: at+jwt`; an ID token is refused), unexpired and not issued in the future (60 s skew).
  Anything else is `401 unauthenticated` with no reason (the reason is logged:
  `admin.staff_token_refused`); an issuer whose keys cannot be fetched while none are cached is
  `503`. Cookies are ignored: a member session never opens a staff route, and a staff token never
  opens a member route. Mutations need `X-Webflix-Client: web`, like the member API.
- **Jobs (service accounts).** A job with no person behind it (the recommendation pipeline's
  calls) gets its token by the client-credentials grant, as from a Keycloak client with a
  service account: `POST {WEBFLIX_STAFF_TOKEN_URL}` with `grant_type=client_credentials` and
  HTTP Basic `WEBFLIX_STAFF_CLIENT_ID:WEBFLIX_STAFF_CLIENT_SECRET`. The token is an access token
  for the realm's `service-account-<clientId>` user (`azp` the client, the roles fixed on the
  client, no refresh or ID token, five minutes: fetch another when it ends). Outside production
  the development staff issuer has one such client: `WEBFLIX_STAFF_TOKEN_URL` =
  `{WEBFLIX_PUBLIC_ORIGIN}/dev-idp/staff/token`, client `webflix-jobs`, secret
  `dev-only-jobs-client-secret`, roles `admin` and `experiments` (`WEBFLIX_DEV_CLIENTS.staffJobs`
  in `@webflix/dev-idp`). Against Keycloak, create a confidential client with service accounts
  enabled and give its service-account user the `webflix-admin` client roles the job needs.
- **Roles** come from `resource_access["webflix-admin"].roles`: `support`, `billing`, `content`,
  `experiments`, `admin` (passes every check). Each route names one role
  (`x-webflix-staff-role` in OpenAPI); without it, `403 staff_role_required` with `requiredRole`.
  Reading a member's record is `support`'s, so billing agents hold both roles.
- **Audit.** Every mutating route takes a `reason`; `GET /audit` lists who, what, on whom
  (`target`), why, the request id, and the `outcome`: `pending` (written before the action ran,
  not settled yet), `succeeded`, `failed` (ended with an error; `after.error` names it; a refusal
  of a single-step action changed nothing), `unknown` (a timeout, an unreachable provider, a
  multi-step action refused half-way, or no answer within 15 minutes: check the member before
  trying again). Experiments and editorial changes are written by their areas in the same batch
  as the change; member, billing, privacy and system actions are written before they run and
  settled after, so no such action exists without its entry. Reading a member's record, their
  privacy view or a member search is audited too (`member.viewed`, `member.privacy_viewed`,
  `member.searched` with the query), before the data is returned.
- **Idempotency.** The billing actions (refund, cancel, extend a trial, complimentary period)
  require `idempotencyKey` (16-64 of `[A-Za-z0-9_-]`, a UUID fits): generate one per submitted
  form and send it again on every retry of that form. A retry of a request that succeeded answers
  the first response again; while the first is running, after it failed or ended `unknown`, or
  with other parameters or another staff member, it answers `409 staff_action_conflict` and acts
  on nothing.
- **What staff see.** A member's record has no password hash (only `hasPassword`), no token, no
  issuer subject and no card details, and its invoices have no hosted-invoice or PDF link (bearer
  links to the member's invoice). The privacy view has the consent and the requests, never an
  export's download link (`downloadUrl` is always null) and never the member's behaviour events.
  Dead letters are listed without their payloads.
- **Operators.** `GET /system/privacy/erasures` lists the pseudonymous keys (deleted accounts,
  profiles made restricted) the lake's compaction must drop (`compact --erase FILE`); `POST /system/privacy/erasures/confirm` records
  that it did. `GET /system/privacy/exports` lists the data exports whose events the pipeline's
  `export-events` job must extract (request id, pseudonymous account key, receipt window);
  `POST /system/privacy/exports/results` takes the job's results document, whose `file` and
  `manifest` can only name that request's own `privacy/export-events/{requestId}/` documents.
  Both audited like the erasure routes (calling them from `export-events` is the pipeline
  owner's wiring, as it was for `erase`). `POST /system/recommendations/rollback` serves
  the previous model run again.
  Dead letters: the job processor records a job that fails its last attempt (the fifth, every
  queue's setting) in `job_dead_letters` in every mode; `POST /system/dead-letters/:id/replay`
  publishes it again, once. `GET /system/health` probes the database, the cache and the
  recommendation store (2 s each) and counts dead letters; queue depth is null (no queue port
  reports it; Valkey's is on `/metrics`).

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
| `WEBFLIX_RATE_LIMIT_OIDC` / `_EMAIL_SEND` / `_EVENTS` | `30/60`, `10/900`, `120/60` (relaxed in dev, §3) | Milestone 2: federated sign-ins, emailed links and event batches |
| `WEBFLIX_RATE_LIMIT_EMAIL_SEND_RECIPIENT` / `_PROMOTION` | `5/900`, `10/600` (every mode) | Milestone 2: emails to one address, promo-code lookups per account |

### Milestone 2 (portable; one loader per area, `packages/core/src/areas/<area>/config.ts`)

Every adapter variable defaults to `memory`. The other values are reserved for the adapter its
area builds; until then a deployment that names one fails at startup with a `ConfigError`
naming the area (docs/FOUNDATION.md §8). Dev mode still needs no variables.

| Variable | Default | Area | Meaning |
| --- | --- | --- | --- |
| `WEBFLIX_IDENTITY_PROVIDER` | `oidc` | identity | `oidc`: the generic OpenID relying party, one per offered issuer; outside production Google and Apple without a client of their own use the development issuer mounted at `/dev-idp/*`, called in process (no proxy needed for the server's calls). `memory`: no federated sign-in (tests inject a `MemoryIdentityProvider`) |
| `WEBFLIX_OIDC_PROVIDERS` | `google,apple` | identity | Consumer issuers offered, in button order (`google`, `apple`, `keycloak`). In production an issuer without a client is not offered (logged as `identity.providers_not_offered`); one named here explicitly without a client fails startup |
| `WEBFLIX_OIDC_GOOGLE_CLIENT_ID`, `_CLIENT_SECRET` | unset | identity | A real Google client (secret 16+ chars). `WEBFLIX_OIDC_GOOGLE_ISSUER` defaults to `https://accounts.google.com`. Wiring the owner's client is configuration only |
| `WEBFLIX_OIDC_APPLE_CLIENT_ID`, `_TEAM_ID`, `_KEY_ID`, `_PRIVATE_KEY` | unset | identity | Sign in with Apple: the Services ID, team, key id and the `.p8` key (PKCS#8 PEM; literal `\n` accepted); the client secret is an ES256 JWT minted per token request. `WEBFLIX_OIDC_APPLE_ISSUER` defaults to `https://appleid.apple.com` |
| `WEBFLIX_OIDC_KEYCLOAK_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET` | unset | identity | Keycloak as a consumer issuer (no secret: a public client with PKCE) |
| `WEBFLIX_OIDC_<PROVIDER>_REPORTS_AUTH_TIME` | `false` (Keycloak `true`) | identity | Offer a fresh sign-in with that issuer as the account-holder proof (`Elevation.methods`). A proof is judged by `auth_time` alone and fails closed without it; leave `false` until the issuer's behaviour under `max_age=0` is checked (Google does not promise `auth_time`) |
| `WEBFLIX_OIDC_TIMEOUT_MS` | `5000` | identity | Deadline of each call to an issuer (discovery, JWKS, token) |
| `WEBFLIX_OIDC_JWKS_REFETCH_COOLDOWN_SEC` | `10` | identity | An ID token signed by an unknown key refetches the JWKS only when the last fetch is at least this old (`0`: always once) |
| `WEBFLIX_EMAIL_SENDER` | `memory` | identity | `memory` (dev mailbox, one process), `smtp` (Node only: Mailpit on kind), `http` (an HTTP provider), `outbox` (the database outbox: D1 on local Cloudflare, every isolate sees it; also the database on Node). `memory` and `outbox` deliver nothing: production logs `identity.email_not_delivered` |
| `WEBFLIX_EMAIL_FROM` | `Webflix <no-reply@webflix.dev>` | identity | Sender of every message (`Name <address>` or an address) |
| `WEBFLIX_EMAIL_HTTP_API_KEY`, `WEBFLIX_EMAIL_HTTP_URL`, `WEBFLIX_EMAIL_HTTP_PROVIDER` | unset, `https://api.resend.com/emails`, `resend` | identity | The `http` sender: Resend's REST API (bearer key, `Idempotency-Key`). Never logged |
| `WEBFLIX_EMAIL_WEBHOOK_SECRET` | unset | identity | Verifies `POST /api/v1/webhooks/email/resend` (Svix-signed, five-minute tolerance); unset: the webhook answers `not_found` |
| `WEBFLIX_SMTP_HOST`, `_PORT`, `_TLS`, `_USERNAME`, `_PASSWORD` | unset, `1025` (`465` with TLS), `none` | identity | The `smtp` sender. `_TLS`: `none` (Mailpit) or `implicit`; credentials are refused without TLS |
| `WEBFLIX_DEV_IDP_SECRET` | derived from the first `WEBFLIX_MEDIA_TOKEN_KEYS` secret | identity | Seals the development issuer's codes and sessions (32+ chars); every replica or isolate must share it, which the derived default already does. Its single-use markers live in the identity area's claims table (shared across replicas and isolates). On Kubernetes outside production the chart generates one in its app Secret, shared by every pod |
| `WEBFLIX_PAYMENT_PROVIDER` | `fake` outside production; `none` in production | billing | `fake` (packages/payments-fake: state in the mode's database, shared safely by every replica and isolate through compare-and-set commits; its form at `/_pay/*`; refused in production), `stripe` (packages/adapters-stripe), `none` (no provider: `GET /billing/config` answers `{"provider":"none"}`, starting or confirming a checkout and validating a promo code answer `503 payments_not_configured`, the webhook route `not_found`; decided from configuration alone, so every replica answers the same), `memory` (the in-process reference for tests; refused in production) |
| `WEBFLIX_BILLING_GRACE_SEC` | `604800` (7 days) | billing | `past_due` stays entitled this long after the first failed renewal attempt (judged in the provider's time); then `suspended` (`grace_expired`), whether or not the provider still retries |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | unset | billing | Required for `stripe`; the names `tools/stripe` writes to `.cache/stripe/stripe.env`. Never logged. A test secret key in production is refused |
| `WEBFLIX_PAYMENTS_FAKE_WEBHOOK_SECRET` | development constant | billing | The fake provider's webhook signing secret (24+ chars); every replica or isolate must share it |
| `WEBFLIX_PAYMENTS_FAKE_DELIVERY` | `orderly` | billing | How the fake delivers its webhooks at start: `orderly`, `unruly` (any order, some twice, some up to 2 s late) or `outage` (none; reconciliation recovers). Changeable at run time: `PUT /_pay/api/delivery` |
| `WEBFLIX_PAYMENTS_FAKE_PROMOTIONS` | `WEBFLIX50:50%` | billing | Standing promo codes of the fake provider (never expiring, never exhausted, every plan): `CODE:<1-100>%` or `CODE:<amount in minor units, USD>`, comma-separated; `none` for no code. A fake-provider deployment has no other way to get one (finding M2-F1) |
| `WEBFLIX_PAYMENTS_FAKE_RETRIES_EXHAUSTED` | `unpaid` | billing | What the fake does when a renewal's retries (3, 5 and 8 days after the first failure) all fail: `unpaid` (recoverable by paying, §5.2's recommended setting) or `cancel` (Stripe's implied default) |
| `WEBFLIX_EVENT_SINK` | `memory` | events | `memory` (in process: tests, and nothing to keep) or `lake` (gzip NDJSON under `events/dt=…/hh=…/` in the mode's blob store: `.data/blobs` in dev, S3 on k8s, R2 on Cloudflare). A Worker's memory sink is per isolate: use `lake` there |
| `WEBFLIX_CONSENT_MODE` | `opt-in` | events | `opt-in` (nothing collected until a purpose is granted), `opt-out` (collected until withdrawn; Global Privacy Control records a withdrawal) or `off` (nothing collected, server events included) (§6.3) |
| `WEBFLIX_PSEUDONYM_KEY` | development key | events | HMAC key of the pseudonymous subject keys (32+ chars); required in production once events are stored. Serving derives profile keys with it (`createSubjectKeys`), so every process that reads recommendations needs the same value. The Helm chart generates it once in its app Secret (`secrets.appExistingSecret` to bring your own), kept on uninstall and never replaced |
| `WEBFLIX_EVENTS_RETENTION_DAYS` / `WEBFLIX_AGGREGATES_RETENTION_DAYS` | `396` / `1126` | events | Raw events 13 months, aggregates 37 months; the data export reads raw events this far back |
| `WEBFLIX_DELETION_COOLING_OFF_SEC` | `1209600` (14 days) | events | A requested account deletion waits this long (cancellable) before the erasure job runs |
| `WEBFLIX_EXPORT_LINK_TTL_SEC` | `604800` (7 days) | events | How long a data export's signed link and its document stay available (then the sweep deletes the document) |
| `WEBFLIX_EXPORT_EVENTS` | `inline` in dev; `batch` on k8s and Cloudflare | events | Where a data export's events come from (§3 "Download your data"). `inline`: the export job reads the account's events across the raw retention itself (small deployments: one job reads up to 13 months of hours). `batch`: the pipeline's `export-events` job extracts them and the result is recorded through `GET /system/privacy/exports` and `POST /system/privacy/exports/results`. `inline` is refused on Cloudflare (a Worker invocation cannot read the retention window). On Kubernetes the chart's pipeline runs `export-events` in its lake round every 5 minutes (docs/KUBERNETES.md §9.6) |
| `WEBFLIX_RELEASE` | `dev` | events | `app.version` of server events (1-40 of `[A-Za-z0-9._+-]`): set it to the deployed release. The Helm chart sets the API image's tag (`config.events.release` overrides); the kind make fragment no longer exports a variable of this name (its Helm release name is `WEBFLIX_HELM_RELEASE`) |
| `WEBFLIX_RECOMMENDATION_STORE` | `database` | personalisation | Where imported models live: `database` (SQLite in dev, PostgreSQL on k8s, D1 for everything on Cloudflare), `kv` (Cloudflare only: per-profile lists in Workers KV `RECS`, models and neighbours in D1; wrangler.jsonc sets it), `memory` (tests) |
| `WEBFLIX_RECS_DEFAULT_POLICY` | `learned` | personalisation | Ranking policy of profiles no experiment assigns: `learned` (learned candidates where a fresh model has them, the rule engine elsewhere) or `rules` |
| `WEBFLIX_RECS_EXPERIMENT` | `recs.learned-vs-rules` | personalisation | The experiment that picks the policy: its control variant gets the rule engine, every other variant learned candidates |
| `WEBFLIX_RECS_EXPLORE_SHARE` | `0.05` in production, else `0` | personalisation | Share of sessions (by session and UTC day) shown rows and items in random order (`BrowsePage.policy.explore`); 0 keeps local suites that assert row order deterministic |
| `WEBFLIX_RECS_READ_TIMEOUT_MS` | `250` | personalisation | A recommendation-store read slower than this counts as unavailable: the page is the rule engine's, and the store is skipped for 30 s |
| `WEBFLIX_EXPERIMENTS` | `database` | experiments | `database` (definitions in the experiments table, read through process memory and the shared cache; every copy is used at most 30 s after its database read) or `memory` (tests) |
| `WEBFLIX_EXPERIMENTS_PROPAGATION_SEC` | dev `0`, k8s and Cloudflare `60` | experiments | How far ahead a status change (start, pause, stop) takes effect for assignment, at one instant on every replica and isolate (`ExperimentDefinition.statusChangeAt`); must exceed 30 s wherever several instances serve (finding K4) |
| `WEBFLIX_EXPERIMENTS_NEW_MEMBER_DAYS` | `30` | experiments | A member counts as "new" for experiment targeting this many days after joining |
| `WEBFLIX_STAFF_VERIFIER` | `oidc` outside production; `memory` in production | admin | `oidc`: staff access tokens validated offline against the staff issuer's published keys (discovery, then its JWKS; Web Crypto, every runtime). `memory`: tokens can only be minted in process, so the staff API admits nobody (production logs `admin.staff_api_closed` until an issuer is configured) |
| `WEBFLIX_STAFF_ISSUER` | unset: outside production `{WEBFLIX_PUBLIC_ORIGIN}/dev-idp/staff`, the development issuer's staff realm, read in process | admin | The exact staff issuer, e.g. a Keycloak realm `https://sso.example/realms/webflix` (https in production, no trailing slash). Required for `oidc` in production. Pointing the API at Keycloak is this variable only. The Helm chart's optional Keycloak (`keycloak.enabled`) sets it to its realm, `https://<release>-keycloak:8443/realms/webflix` by default (docs/KUBERNETES.md §9.4) |
| `WEBFLIX_STAFF_AUDIENCE` / `WEBFLIX_STAFF_CLIENT_ID` | `webflix-admin-api` / `webflix-admin` | admin | The admin API's audience (`aud` must contain it); the client whose roles count (`resource_access.<client>.roles`) |
| `WEBFLIX_STAFF_ALGORITHMS` | `RS256` | admin | Signature algorithms accepted on staff tokens (`RS256`, `ES256`, comma-separated), fixed here and never read from a token. Keycloak signs with RS256 by default |

### Node (`apps/api`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | Listen port (`serve` and `worker`) |
| `HOST` | all interfaces | Listen address |
| `WEBFLIX_DATABASE_URL` | dev: `sqlite:<repo>/.data/webflix.sqlite`; required otherwise | `postgres://user:pass@host:5432/db` or `sqlite:<path>` / `sqlite::memory:` |
| `WEBFLIX_DATABASE_POOL_MAX` | `10` | Postgres pool size per process |
| `WEBFLIX_DATABASE_<ROLE>_STATEMENT_TIMEOUT_MS`, `WEBFLIX_DATABASE_<ROLE>_QUERY_TIMEOUT_MS` (`<ROLE>`: `REQUEST`, `BACKGROUND`, `MAINTENANCE`) | the role's budget (§6: 5 000 / 7 000, 60 000 / 65 000, 600 000 / 605 000) | Override one role's server-side `statement_timeout` and client-side query timeout (ms, `0` = none). Each process uses its own role's (`serve` and `wait`: request, `worker`: background, `migrate` and `seed`: maintenance); the query timeout must exceed the statement timeout, or both be `0`, else startup fails |
| `WEBFLIX_DATABASE_KEEPALIVE_MS` | `10000` | TCP keepalive's first probe on database connections (`0` = off); interval and count are the host's (the chart sets 10 s × 3) |
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

Tests: `WEBFLIX_TEST_POSTGRES_URL` enables the Postgres runs of the `packages/db` suites;
`WEBFLIX_TEST_VALKEY_URL` and `WEBFLIX_TEST_S3_*` the Valkey and S3 runs (`test:services` sets
them).

### Cloudflare only (`apps/edge`)

The Worker reads the portable variables above as vars and secrets, plus its own
`WEBFLIX_PASSWORD_ITERATIONS` and `WEBFLIX_EDGE_CACHE` (docs/CLOUDFLARE.md §6 and §3).
Milestone 2 binds a second KV namespace, `RECS`, for per-profile recommendation lists
(`WEBFLIX_RECOMMENDATION_STORE=kv`); `make cf-provision` creates `webflix-recs` and writes its
id. wrangler.jsonc sets, locally and in production: `WEBFLIX_EVENT_SINK=lake`, the email sender
(`outbox` locally, `http` in production), the payment provider (`fake` locally, `stripe` in
production), the staff verifier (the development issuer locally, closed in production until an
issuer is configured) and `WEBFLIX_RELEASE` (`local`; the deployed commit in production).
Secrets, the same names in both sections: `WEBFLIX_MEDIA_TOKEN_KEYS`, `WEBFLIX_PSEUDONYM_KEY`,
`WEBFLIX_EMAIL_HTTP_API_KEY`, `WEBFLIX_EMAIL_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` (`.dev.vars` locally, written by
`make cf-dev`; docs/CLOUDFLARE.md §8 and §10.2).

Recommendation runs are imported from Node, not inside the Worker (a Worker invocation has
1,000 KV operations): `make cf-recs-import` (`node apps/edge/scripts/ops.ts recs import [--run
<run>] [--from <dir>] [--target production]`), with `cf-lake-pull` / `cf-recs-push` moving the
lake out of R2 and a scored run back in (docs/CLOUDFLARE.md §10.4). The events of a data export
(`WEBFLIX_EXPORT_EVENTS=batch`, the only mode on Cloudflare) and the erasure of lake rows are the
pipeline's jobs; against the local Worker, `make cf-export-events` and `make cf-erase` run them
with a `webflix-jobs` token and write their output back into the local R2, and
`make cf-dev CF_JOBS_EVERY=<seconds>` runs them on a loop for test runs (docs/CLOUDFLARE.md §10.4).

### Recommendation importer (Node)

`node apps/api/src/recs.ts import [--run <run>] [--from <dir>]` publishes the pipeline's run
(`recs/current.json` in the mode's blob store, or `--from` a pipeline store directory such as
`.cache/recs/medium/store`) into the recommendation store; `rollback` serves the previous run
again (one write); `status` prints the served model and the last import. Same environment as the
API (it opens the database with the `worker` role). The staff API's
`POST /system/recommendations/import` queues the same import as a job
(`recommendations.import`). Scheduling it (a CronJob, a Cron Trigger) is wiring: it is cheap when
nothing new was published (one pointer and one manifest read). In the Worker an import is bounded
by one invocation's KV budget: a run with more than 800 profile lists is refused up front (`422
recommendation_import_too_large`, naming `make cf-recs-import`, the importer outside the Worker).

`node apps/api/src/recs.ts experiments-import [--from <dir>]` imports the experiment results the
pipeline's `analyse-experiments` published (`experiments/results/current.json`, each result
checked against its size and SHA-256; services/recs/README.md, "Experiment results"): one report
per experiment and analysis time, experiments the product does not know skipped, the same pointer
imported twice changing nothing; exit 1 when a result failed verification. The same import is the
job `experiments.import-results`, which every scheduler tick publishes in both runtimes; it stops
at once when the pointer is the one it last imported.

## 5. Composition and plugging in adapters

Everything is built from ports:

```ts
const services = createServices({            // @webflix/core
  config, repos, search, cache, streamGate, jobs, passwords, mediaTokens, billing, clock, ids, logger,
  // Milestone 2 (`AreaPorts`): built per area by apps/*/src/areas/<area>.ts, memory by default.
  identityProviders, email, payments, eventSink, recommendations, experiments, staff,
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
| k8s | PostgreSQL via `pg` | `createPostgresDatabase({ connectionString, maxConnections, role })` from `@webflix/db/postgres` |
| cloudflare | D1 | `createD1Database(env.DB)` from `@webflix/db/d1` |

#### PostgreSQL time budgets and failure modes

Each process opens its pool with a role (`createPostgresDatabase({ role })`, DECISIONS.md D42):

| Role | Used by | `statement_timeout` (server) | Client-side query timeout | Idle in transaction (server ends it) |
| --- | --- | --- | --- | --- |
| `request` | `serve` (HTTP API), `wait` | 5 s | 7 s | 7 s |
| `background` | `worker` (jobs, scheduler) | 60 s | 65 s | 65 s |
| `maintenance` | `migrate`, `seed` | 10 min | 10 min 5 s | 10 min 5 s |
| none given | (library default; `apps/api` always passes one) | 15 s | 17 s | 17 s |

`apps/api` maps each process to its role (`DATABASE_ROLES` in `src/adapters.ts`); a runtime
composed for an unknown process name fails with a `ConfigError` instead of falling back to a
default budget. Every role: at most 5 s to open a connection or get a free one from the pool,
TCP keepalive from 10 s of idleness. An API request therefore waits at most about 12 s on the database
before it answers 503 `service_unavailable` with `Retry-After` (the gateway's route timeout is
60 s).

| Failure | What happens |
| --- | --- |
| A statement runs too long on a reachable server | The server cancels it (`57014`): 500, retrying would be as slow |
| Server restart, graceful shutdown, failover (`57P01`, closed sockets) | The requests in flight answer 503; the connections are discarded; the process never exits (D41) |
| The server stops answering (partition, host lost with its connections) | The statement fails client-side after the role's query timeout: 503; its connection is destroyed, never reused; the next request opens a new one (5 s bound) |
| A transaction cut before COMMIT went out | Nothing of it is applied: the server rolls it back when it sees the connection gone or after the idle-in-transaction timeout (no locks left behind) |
| The connection lost after COMMIT went out | Outcome unknown: 503 whose detail says the change may or may not have been saved. The web app never retries a mutation on its own |

One repository implementation serves all three; the repository contract suite
(`describeRepositoryContract` in `@webflix/core/testing`) passes on memory, SQLite, Postgres 19
and D1 in workerd. A test introspects SQLite and Postgres schemas and asserts identical tables,
columns, type families and nullability.

### Migrations

- Authored once in TypeScript: `packages/db/src/migrations/0001_initial.ts`, and from milestone 2
  one directory per area (`migrations/<area>/NNNN_<area>[_<change>].ts`, listed in that
  directory's `index.ts`; `migrations/index.ts` sorts them all by name). Never edit a shipped
  migration; add one.
- Milestone 2 (0002–0007) only creates tables and adds nullable columns to milestone 1's
  (`accounts.email_verified_at`, `sessions.elevated_until`). Never rebuild a table others
  reference: on SQLite and D1 dropping the parent cascades deletes into every child, even with
  `defer_foreign_keys` (a migration test refuses DROP TABLE and RENAME). Tests prove the upgrade
  of a populated milestone 1 database on SQLite (`packages/db/test/migrations.test.ts`) and on
  D1 with the generated files (`test/workerd/upgrade.test.ts`).
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
unchanged). The hash includes a seed format version: format 3 stores each packaged asset's
nominal best height and measures demo progress on the playable stream; format 4 makes the
runtimes of packaged titles and episodes their stream's duration and records what each preview
is. Every deployment re-applies the seed once per format (it resets the demo account, as any
re-seed does).

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
  the profile's library), learned candidates and experiments included (their reads are cached;
  per-profile lists are a Workers KV read on Cloudflare); cold ≤ 4 with milestone 1's caches,
  7 once the recommendation model, the experiment definitions and the editorial data are cold
  too (8 on SQL with a profile's lists: docs/RECOMMENDATIONS.md, "Learned candidates"); title
  detail 2; search ≤ 4; a heartbeat, and a release that
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

Milestone 2: the seven port suites (`describeIdentityProviderContract`,
`describePaymentProviderContract`, `describeEmailSenderContract`, `describeEventSinkContract`,
`describeRecommendationStoreContract`, `describeExperimentsContract`,
`describeStaffVerifierContract`) run against memory in `packages/core/test/contracts.test.ts`
(the event sink also over a blob store); each adapter runs its suite in the runtime it ships to.
The area repository suites (`describe<Area>RepositoryContract`) run on memory, SQLite,
PostgreSQL and D1. `packages/http/test/milestone2.test.ts` covers the uniform 501, the staff
guard and the new route kinds; `packages/contracts/test/no-card-data.test.ts` refuses card
fields outside `LEGACY_CARD_FIELDS`. The staff API: `packages/http/test/admin-guard.test.ts`
(every staff route against every role, no token, a member session; a staff token on every
member route), `admin-api.test.ts` (each action, its audit entry, the write-ahead entry under
failure, refund idempotency, least data), `staff-verifier.test.ts` (the OpenID verifier against
the contract and the development issuer's token faults), and `staff-api.test.ts` in apps/api
(SQLite, real issuer tokens) and apps/edge (workerd, D1).
