# Webflix — Backend decisions

Decisions taken while building the backend (`packages/core`, `packages/db`, `packages/http`,
`apps/api`). Each says what was decided, why, and what it costs. Newest last; supersede rather
than rewrite.

---

## D1. Stream limits vs stateless media tokens (resolves FOUNDATION §6)

**Decision.** Enforce the plan's concurrent-stream limit at three points:

1. **Start** (`POST /playback/sessions`): `StreamGate.acquire` per account; over the limit →
   `409 stream_limit_reached` with the active streams. One lease per device: starting another
   title on the same device replaces its stream instead of counting twice.
2. **Heartbeat** (every 30 s): `StreamGate.renew`; a revoked or expired lease →
   `410 playback_session_ended`, and the official player stops.
3. **Playlists** (`GET /media/{token}/vod/{asset}/*.m3u8`): besides the stateless token check,
   the playback session must still hold its lease, else `410 playback_session_ended`.

**Segments, subtitles and trick-play sheets stay stateless** (HMAC token, no database, no gate),
with the token TTL at its default 6 h (`WEBFLIX_MEDIA_TOKEN_TTL_SEC`).

**Why.** Playlists are a handful of requests per playback (master, one media playlist per
rendition switch, subtitles playlist), so checking the lease there is cheap even on Cloudflare
(one D1 read + one Durable Object call). Segments are the bulk of traffic and stay as cheap as
static files. A copied manifest URL stops working for any new player, and for rendition switches
of a running one, as soon as the slot is revoked (sign-out, device revoke, password change, plan
downgrade, a missed-heartbeat expiry). A long TTL avoids interrupting a film mid-way.

**Cost.** A player that already has its media playlist can keep fetching segments of that
rendition until the token expires. Accepted: no DRM is in scope (blueprint §1.3), and the
official player stops on the heartbeat answer anyway. The alternative (short TTL and recreating
the session from the current position) adds player complexity and latency spikes for little
extra protection without DRM.

**Also**: the master playlist is filtered server-side to the plan's maximum height
(`capMasterPlaylist`). *Corrected:* that alone did not stop Basic from fetching a 1080p
rendition by its URL (only the master was filtered); every rendition above the cap is now
refused, statelessly, by the claim the token carries (D26).

## D2. Atomic writes without interactive transactions

**Decision.** Repositories never open a transaction around application code. A write that must
be atomic is one repository method implemented as one `Database.batch([...])` of statements
that do not depend on values read inside the batch; conditions are expressed in SQL (`WHERE`,
`INSERT ... SELECT ... WHERE`, `ON CONFLICT`). `batch` maps to `D1Database.batch()` (implicit
transaction), a Postgres `BEGIN ... COMMIT` on one connection, and a synchronous SQLite
`BEGIN IMMEDIATE ... COMMIT` (no other query in the process can interleave).

Examples: sign-up (account + membership + first session), the five-profile limit (a no-op
`UPDATE accounts` takes the row lock on Postgres, then `INSERT ... SELECT ... WHERE (SELECT
count(*) ...) < 5`; SQLite and D1 serialise writers anyway), profile deletion (cascading foreign
keys, guarded by "not the last profile"), heartbeat (playback session + progress + history; the
watched-time credit is computed in the `UPDATE` from the previous row values), catalog re-seed
(delete + insert, readers never see half a catalog).

**Why.** D1 has no interactive transactions; designing for it from the start keeps one
implementation for every dialect.

## D3. D1 limits enforced everywhere

The 100-bound-parameter cap is checked on **every** dialect, in the drivers
(`assertParameterCount`), so a query that works in dev (SQLite) or k8s (Postgres) works on D1.
Bulk inserts are chunked by `floor(100 / columns)` rows, `IN` lists by 90. Other D1 limits are
respected by construction: ≤ 100 columns per table and per result (widest table: 22), ≤ 5 terms
per compound `SELECT` (none used), LIKE patterns ≤ 50 bytes, one batch per hot read path
(counted as one query against the 1 000 per invocation cap). *Corrected:* suggestion tokens were
cut to 40 *characters*, which is up to 160 bytes (a long CJK or Cyrillic word answered 500 on
D1); they are now cut to the 47 UTF-8 bytes a `% <token>%` pattern leaves, between code points
(`prefixWithinUtf8Bytes`), on every dialect so results agree. The search contract suite runs
CJK, Cyrillic, astral-plane letters, emoji and combining marks on every adapter, D1 in workerd
included.

## D4. Physical representation

Text ids (UUIDv7 at runtime, slugs in seeds); timestamps as epoch milliseconds in
`integer`/`bigint` (the pg driver returns int8 and numeric as JS numbers); booleans as 0/1
`integer` on every dialect (one set of predicates, mapped to `boolean` in one place); JSON as
`text`. The schema is authored once (`packages/db/src/migrations`); Postgres and SQLite/D1 differ
only in the time/real column types and the search index. A test introspects both and compares
tables, columns, type families and nullability.

## D5. Migrations

Node (dev, k8s) runs Kysely's migrator (`webflix-api migrate`; it takes a lock table, so
concurrent pods are safe). D1 is migrated by `wrangler d1 migrations apply` from SQL files that
are **generated** from the same TypeScript migrations (`pnpm --filter @webflix/db generate`,
written to `packages/db/migrations/d1/`); a test fails while they are stale, and the workerd test
suite applies exactly those files.

## D6. Search lives in the application database

SQLite and D1 use an FTS5 table (`bm25` with column weights name 10, people 5, genres 4, moods
3, synopsis 1); Postgres uses a stored, weighted `tsvector` (A name, B people, C genres+moods, D
synopsis) with a GIN index and `ts_rank`. Text is normalised in JavaScript (`normalizeSearchText`:
lowercase, no diacritics, no punctuation) before indexing and querying, so both engines see the
same tokens and no extension (`unaccent`, `pg_trgm`) is needed on managed Postgres. Suggestions
use a plain label table with token-prefix `LIKE`s, identical on every dialect. Trigram typo
tolerance is optional in the port contract and not implemented.

## D7. Caching only what tolerates staleness

The catalog snapshot (memory 30 s → KV 5 min) and popularity counters (memory 60 s → KV 5 min,
keyed by UTC day) are cached through the `KeyValueCache` port. Personal state (My List, ratings,
progress, sessions, stream counts) is always read from the database or the gate: KV is eventually
consistent and the UI does optimistic updates that must be confirmed by the next read.

## D8. Popularity from recomputation, not counters

Daily title stats are recomputed per day from playback sessions by an idempotent job, so
at-least-once delivery (Queues, Valkey Streams) cannot double count. A deterministic synthetic
baseline (`source = seed`) keeps Trending and Top 10 meaningful; it is extended daily by a job
rather than only at seed time. See RECOMMENDATIONS.md.

## D9. Sessions

Opaque 256-bit token in an httpOnly, SameSite=Lax cookie (`__Host-` prefixed and Secure when the
public origin is https); only its SHA-256 is stored. "Remember me" off gives a browser-session
cookie and a 24 h server-side lifetime; on gives `WEBFLIX_SESSION_TTL_DAYS` (30). `lastSeenAt` is
written at most every 5 minutes per session (otherwise every request would be a write). The
active profile is bound to the session row, never taken from a header. Unknown emails are
verified against a dummy hash so "no such account" and "wrong password" take the same time.

## D10. Mock billing

A `BillingProvider` port with one mock implementation. Test cards: `4000 0000 0000 0002` →
`card_declined`, `4000 0000 0000 9995` → `insufficient_funds`, any card with a past expiry →
`expired_card`, anything else → approved (`MOCK_CARDS` in the contract). Periods are 30 days and
renew automatically; status (`active` / `canceling` / `ended`) is derived from the record and the
clock, never stored. Upgrades charge the prorated difference; a new card on a downgrade is
verified with a zero-amount charge; resuming an ended membership charges a new period. A
downgrade to fewer screens ends the newest streams beyond the new limit.

## D11. Parental controls need the account password

Setting or clearing a profile PIN, or raising a profile's maturity ceiling (including turning
off "kids"), requires `currentPassword` (`current_password_invalid` otherwise). PINs are hashed
with the same password hasher. PIN attempts are rate limited per account (`profile-pin`
policy; what counts as an attempt: D18, which supersedes "selecting a profile is rate limited").
*Superseded by D24* (who may change what) *and D25* (every PIN or password check is charged); a
missing password now answers `password_required`, a wrong one `current_password_invalid`.

## D12. Docs UI without third-party calls

`/api/docs` renders Scalar with its standalone bundle served from our own origin
(`/api/docs/scalar.js`; Node serves the file from `@scalar/api-reference`), default fonts off, and
a page CSP that only allows `'self'` for scripts (plus a per-response nonce for the inline
configuration), connections, fonts and images. Even if the bundle tried to reach a CDN, the
browser would block it.

## D13. Packaged media in dev without an upload step

In dev the blob store is the filesystem store in `.data/blobs` layered over a read-only view of
`.cache/media/<profile>` (what `tools/media` writes, laid out by blob key), so `make content`
followed by `pnpm dev` plays packaged media. The seeder picks up the manifest found there. In
other modes media is uploaded to the real store (S3, R2) by the media pipeline.

## D14. Idempotent seeding

`webflix-api seed` (and `serve` in dev) hashes catalog + demo account + manifest + seed format
version and skips when unchanged; `--force` re-applies. Re-seeding replaces the catalog
atomically, upserts notifications (read receipts survive), refreshes the search index, rewrites
the synthetic baseline and resets the demo account to its seeded state (its sessions end).

## D15. Continue Watching is anchored on what was watched far enough to count

**Decision.** A title's state (Continue Watching, every play target, where Play starts) is
computed once, from its most recent item watched at least 30 s or finished; items below that are
samples and never move it. A title with only samples is not started. The full rule table is in
RECOMMENDATIONS.md ("Continue Watching and play targets"). Playback resumes with the same rule
(no separate 30 s "tail" any more), and the seeded demo progress is measured on the stream Play
opens rather than on the catalog runtime.

**Why.** The old rule looked at the latest item only, so a 2 s sample of the next episode (what
autoplay leaves when the member closes the page) removed a series the member was in the middle
of, and a sampled movie was a "resume at 0:02" play target that the row did not list. Three
separate rules (row filter, play target, playback tail) also disagreed on short media and on the
seeded demo progress (the row said 37:48 while Play started at 0). One computation cannot
disagree with itself.

**Cost.** Ten seconds into a new title, leaving and coming back starts over: deliberate (the
reference product behaves the same); the episode list still shows the raw progress.

## D16. Watch-time credit has its own clock; no schema change

**Decision.** A heartbeat (or the final report a release carries) credits
`clamp(position advance, 0, wall-clock time since the session's credit clock, 3 × heartbeat
interval)`, and nothing when the previous report said the session was paused or ended. The clock
then moves forward by the credit, or to `now − 5 s` if it lags further (`HEARTBEAT_CARRY_SEC`).
It is stored in the existing `playback_sessions.last_heartbeat_at` column
(`PlaybackSessionRecord.lastHeartbeatAt`), which nothing else reads; the computation stays one
`UPDATE` in the heartbeat's single batch, every right-hand side reading the previous row.

**Why.** The old bound was "elapsed since the last heartbeat + 5 s per heartbeat", so twelve
heartbeats in two seconds credited a full minute (a view, which feeds Top 10 and Trending), and
a seek while paused was credited as watching. A clock that advances only by what it credits
bounds the total by the session's lifetime however many heartbeats arrive; carrying up to 5 s of
unused time absorbs network jitter without letting slack accumulate; the paused rule removes
seeks while paused. Reusing the column avoids a migration while both deployments roll out (no
window in which new code meets an old schema).

**Cost.** Up to one interval of watching after a pause goes uncredited unless the client reports
the resume (the web app does: `WatchLifecycle.phase`). A backwards seek credits nothing for that
interval. The column's name no longer says exactly what it holds (documented on the record).

## D17. The release carries the final position

**Decision.** `DELETE /playback/sessions/:id` takes an optional body, the final heartbeat
(`HeartbeatBody`, validated identically). With it, the session's own profile records the position
under every heartbeat rule (ownership, a still-held stream slot, clamping, completion, credit) and
the session ends in the same batch; then the slot is freed. A refused report answers `not_found`
or `playback_session_ended` and still frees the profile's own slot. Without a body the release
behaves exactly as before (idempotent, any profile of the account). The contract mechanism is
general: a route whose body schema accepts `undefined` takes an optional body (`isBodyOptional`,
OpenAPI `requestBody.required: false`, `body?` in the typed client).

**Why.** On page close the final heartbeat and the release raced; when the release won, the
position was refused with 410 and lost. One request cannot race with itself, and one `keepalive`
request instead of two also halves what an unload has to get out. The opposite race is closed
in the repository: progress and history are written with `INSERT ... SELECT ... WHERE` the
session is still live, ahead of the session update in the same batch, so an interval heartbeat
already past its checks when the release commits cannot overwrite the final position (it used
to: the guard covered only the session row). *Corrected:* on Postgres that guard alone was not
enough. Under READ COMMITTED a heartbeat whose `INSERT ... SELECT` saw the session live waited
on the release's progress row and then overwrote the final position. Every heartbeat and release
batch now starts with a no-op `UPDATE playback_sessions SET ended_at = ended_at` on its row (as
the profile limit locks the account row, D2): the later batch waits there and its statements
then see the session ended. `packages/db/test/playback-race.test.ts` holds a release open on a
second connection and fails without the lock.

## D18. The PIN limit counts every PIN attempt on a locked profile, and nothing else

**Decision.** `profile-pin` (5/min, per account) is consumed by a `PUT /session/profile` that
submits a PIN for a locked profile, right or wrong, before the PIN is checked. Selecting an
unlocked profile, or a locked one without a PIN (`profile_pin_required`), consumes nothing. The
route table says so (`rateLimitScope: "handler"`); the guard skips such routes' policies and the
handler enforces them (`enforceRateLimit`).

**Why not failed attempts only.** Counting only failures means checking the budget before
verifying and charging it after. The `RateLimiter` port has no "peek", and a check-then-charge
over two calls lets a concurrent burst of guesses through before any failure is recorded, which
defeats the purpose. Counting every attempt keeps one atomic `consume` before the hash
comparison, exact under concurrency on every adapter. Only a member who enters the right PIN
five times in a minute notices, and is told when to retry.

**Why per account.** A key per profile would let a guesser rotate between locked profiles, a key
per device rotate devices. The conformance suite covers both.

*Extended by D25:* the same budget now covers every password check after sign-in as well.

## D19. Card verifications are limited per account

**Decision.** `PUT /account/payment-method` (new) and a plan change that carries a card both
consume the `payment` policy (10 per 10 minutes per account; not relaxed in dev). A plan change
without a card verifies nothing and is not limited.

**Why.** A card endpoint without a limit is a card-testing oracle; limiting only the new endpoint
would leave the old route (a plan change with a card) as the way around it. Per account, because
the request is authenticated and addresses are shared.

## D20. A public, cacheable showcase for signed-out screens

**Decision.** `GET /showcase` returns the 40 most popular titles rated at most 13+ (seed
popularity, then id), with their card, poster, logo and backdrop `ImageSet`s exactly as the
catalog serves them (versioned URLs). It needs no session and depends on nothing personal:
`Cache-Control: public, max-age=300, stale-while-revalidate=86400`, a weak ETag (304 on
revalidation) and no `Vary: Cookie` (every other API response keeps it). The server keeps it in
the `KeyValueCache` (memory 60 s, shared 5 min) so a cold Worker isolate answers from one KV read
instead of loading the whole catalog snapshot; the seeder invalidates it.

**Why.** The landing page hard-coded title ids and built `/cdn` URLs without the content hash,
so immutable caching could show stale art and a catalog change broke the page silently.

## D21. Popularity diagnostics outside production

**Decision.** `GET /titles/:id/popularity` (any signed-in account) returns the stored daily
counters of one title for the last 7 days (baseline views, playback views, credited seconds,
profiles that played), uncached. It answers `not_found` when `WEBFLIX_ENV=production`.

**Why.** Top 10 and Trending cannot move measurably against the synthetic baseline, so the views
pipeline (credit → rollup → counters) had no black-box check. Exact per-title counters make it
observable and deterministic (one honest minute adds exactly one view; a burst of heartbeats adds
none). Read-only, aggregate and absent in production: not a backdoor.

## D22. Badges are chosen per surface by the server

**Decision.** A card's one `badge` depends on where the card is shown: Top 10 only for titles in
the Top 10 list of that page's view, never in Continue Watching or the ranked row, at most two
per list; priority `leaving-soon` > `new-episodes` > `top-10` > `new`. Cards also carry
`top10Rank`, so previews and detail can state the rank where the badge was withheld. Details in
RECOMMENDATIONS.md ("Badges").

**Why.** The badge went to every title of the overall Top 10 on every card, so popular titles
(which dominate the personalised rows of a small catalog) wore it on about half the home page.

## D23. Video quality: one vocabulary, nominal heights, no schema change

**Decision.** Quality tiers are `sd`, `hd`, `full-hd` and `4k`, with exact thresholds on the
*nominal* height (the 16:9 frame a rendition fills: 1920×800 is 1080, 1280×536 is 720), labelled
SD, HD, Full HD and 4K (`VIDEO_QUALITY_*`, `nominalVideoHeight`, `effectiveVideoQuality` in
`@webflix/contracts`). The seeder stores the best packaged rendition's nominal height in
`video_assets.max_height` (seed format 3); the catalog snapshot reads packaged assets' heights in
its existing batch. `TitleCard.bestVideoQuality` (a series: its best episode) and
`PlaybackSession.bestVideoQuality` are absent for external fallback media. Clients show
`effectiveVideoQuality(best, plan.maxVideoHeight)`, the lower of the two.

**Why.** "HD" was hard-coded. Heights alone would call a 1280×536 scope encode "SD", as dishonest
as calling everything HD. `max_height` was written but never read, so its meaning could be made
precise without a migration.

**Cost.** Deployments must re-run the seed once (format 3) for wide-screen titles to be named
right; until then they read one tier low. The tier is the best rendition's: it assumes a ladder
with one rung per tier, which `tools/media` produces.

## D24. Privileges: who may do what on an account

**Decision.** One model, decided in one module (`packages/core/src/services/privileges.ts`) and
enforced where the route table says (`auth: "account-holder"`) or by the profile and account
services calling it; nothing restates a rule. Parental controls are *in use* when any profile is
a kids profile, has a ceiling below 18+, or is locked with a PIN (`ProfileList.parentalControls`).

| Who is acting (the session's active profile) | Profiles | Account (details, plan, card, cancel, devices, sign out everywhere) |
| --- | --- | --- |
| No profile (the gate) | Add: without proof while no parental controls are in use, else with the password. Change or delete: an unlocked profile freely (loosening needs the password); a locked one with its PIN or the password. | Refused: `profile_required` |
| A kids profile | Switch to any profile (a locked one with its PIN). Its own name, avatar and settings. Nothing else: `unrestricted_profile_required`, even with the password. | Refused: `unrestricted_profile_required` |
| A profile with a lowered ceiling (13+ …) | As at the gate | Refused: `unrestricted_profile_required` |
| A profile without parental controls | As at the gate; its own locked profile without its PIN again | Allowed |
| Any profile, loosening a profile (raising its ceiling, turning kids off, setting, changing or removing its PIN) | The account password (`password_required` without it), whoever's profile it is | — |
| Anyone, signing this device out | — | Always allowed (`POST /auth/logout`) |
| The demo account (D29) | Settings only | Not its sign-in details, plan, card, other devices |

Problem codes are specific and stable: `password_required` (no password where one is needed),
`current_password_invalid` (a wrong one), `profile_unlock_required` (a locked profile changed
from another session without its PIN or the password), `profile_pin_invalid`,
`unrestricted_profile_required`, `profile_required`, `demo_account_protected`.

**Why.** A kids session could add an 18+ profile and switch to it, delete a locked profile or
change the plan: parental controls were a speed bump. Account management needing a profile
*without* controls (not merely "not kids") closes the same hole for a teen profile that can
spend money or cancel. A locked profile belongs to its owner: anyone else must unlock it to
change or delete it, even a parent at the gate (the password unlocks too).

**Cost.** An account whose only profiles are restricted cannot reach account management until
it adds an unrestricted one (which needs the password) — the web app explains it. A kids
profile cannot rename another profile even when an adult hands over the remote; switching to
the adult's profile is one click.

## D25. One credential budget, charged before any hashing

**Decision.** Every PIN or password check after sign-in goes through
`services/credentials.ts`, which takes a required `charge` callback and calls it before the hash
comparison; HTTP passes `enforceRateLimit(..., "profile-pin")` (the policy keeps its name for
configuration compatibility). Charged: `PUT /session/profile` with a PIN, `PATCH /account`,
`POST /profiles` and `PATCH`/`DELETE /profiles/:id` when they verify a PIN or the password.
Requests that need no proof (or send a password nobody asked for) are not charged.
`packages/core/test/credential-call-sites.test.ts` lists every `PasswordHasher.verify` call in
the server sources and fails on a new one outside the charged module, sign-in (D28) and the
seeder (D29).

**Why.** `PATCH /profiles/:id` with `currentPassword` was an unmetered password oracle for anyone
holding a session (a kid's tablet): 25 guesses, 25 answers. One budget per account means no
route is a way around another.

**Cost.** A parent who enters the password five times in a minute while setting up profiles waits
up to a minute; the web app shows the retry time.

## D26. The quality cap holds for every rendition, statelessly

**Decision.** Media tokens carry the plan's height cap (claim `h`). For any request under an
asset except its master, the HTTP layer refuses (`403 media_quality_restricted`) a path under a
rendition directory the capped master leaves out (`renditionsAboveCap`, the same height rule as
`capMasterPlaylist`). The directory map is read from the asset's master playlist and kept per
process (per isolate on Workers) for ten minutes, settled results only (D36): the first segment
of an asset in a process costs one extra blob read, later ones none, and segments never touch the
database. Tokens issued before the claim existed (no `h`) stay uncapped until they expire.

**Why.** The master was filtered but every rendition stayed fetchable by URL: a Basic member could
watch 1080p by asking for `1080p/index.m3u8`. Checking the session in the database per segment
would undo D1's cost model.

**Cost.** A directory that also holds a rendition within the cap (or a variant beside the master)
cannot be refused as a whole; `tools/media` packages one directory per rendition, so none does.
A rollout leaves old tokens uncapped for at most their lifetime (6 h).

## D27. Client addresses by subscriber; playback starts per account

**Decision.** Address-keyed limits (`auth`, `signup`, `email-lookup`) key an IPv6 client by its
/64 (IPv4-mapped addresses as IPv4; `clientAddressKey`). `POST /playback/sessions` is limited per
account (`playback-start`, 60/min, the same in dev).

**Why.** A subscriber gets a /64 or more and can rotate through it freely; keying the full address
limited nothing for IPv6 clients. Starting sessions was unmetered: each start writes a row and
calls the stream gate.

## D28. Sign-ins are limited per email address; known browsers are exempt

**Decision.** Besides the per-address `auth` limit, `POST /auth/login` charges `auth-email`
(10 per 15 min) keyed by a digest of the email address, before the password hash is compared;
unknown addresses are charged alike (no enumeration through the limit). A browser that signed up
or signed in to the account before carries a signed "known device" cookie
(`webflix_device`, HttpOnly, a year; HMAC with the media token keys under its own purpose, no
storage) and is exempt; so is the demo account, whose password is public.

**Why.** Per-address limits do nothing against guesses spread over many addresses. Without the
exemption, anyone could lock the owner out of their own account by spending its budget.

**Cost (the trade-off).** An attacker can still keep an account from signing in on *new*
browsers (10 guesses per 15 minutes, from anywhere); the owner's existing browsers are never
locked out, and a new browser waits at most 15 minutes. Rotating the media token keys makes every
browser unknown once.

## D29. The demo account is protected; the seeder repairs it

**Decision.** On the seeded demo account the API refuses (`demo_account_protected`) changing the
email or password, the plan, the card, cancelling, signing other devices out (everywhere or one
by one), and adding, deleting, renaming, re-picturing, locking or loosening profiles. Viewing,
settings, My List, ratings and switching profiles work. `Account.isDemo` lets the web app say so
once. A seed run that finds nothing new to apply still compares the demo account's protected
state with the seed (sign-in details, membership, profiles) and resets the account when it
drifted (`SeedResult.demoRestored`, log `seed.demo_restored`), which also signs everyone out of it.

**Why.** Anyone could take the shared account over (change its password) and the takeover
survived restarts, because the seeder skipped unchanged inputs.

## D30. A new PIN signs the profile's other devices off it

**Decision.** Setting or changing a PIN clears `active_profile_id` on every other session bound to
that profile in the same batch as the profile write, and frees those devices' stream slots. Their
next request answers `profile_required`; the web app returns to the gate (and the player shows
that the profile was locked elsewhere).

**Why.** Locking a profile left devices already on it inside, which is exactly what a lock is for.

## D31. Profile updates write only what changed

**Decision.** `ProfileRepository.update(accountId, profileId, patch)` writes the patched columns
in one statement; settings are merged key by key in SQL (`json_set` on SQLite/D1, `jsonb ||` on
Postgres).

**Why.** The service read the row, merged the request and wrote every column back: two edits of
different fields from two devices lost one of them.

## D32. Expired sessions are deleted by a bounded job

**Decision.** The scheduler publishes `sessions.cleanup` with every tick (5 min); it deletes up to
500 expired sessions, oldest first, in one statement, and publishes itself again while full
batches come back. Log `sessions.cleaned_up {deleted, more}`, like `playback.cleaned_up`.

**Cost.** No index on `sessions.expires_at` (no migration): each run scans the sessions table,
cheap at this scale.

## D33. A database that cannot be reached answers 503

**Decision.** Repositories and the search index map connection-level failures to
`service_unavailable` (503, `Retry-After: 5`) on every dialect (`isDatabaseUnavailable`: refused,
reset or timed-out connections, Postgres classes 08 / 57P01–57P03 / 53300, node-postgres's pool
timeout, SQLite "unable to open" or "database is locked", D1's documented transient errors). The
request logs `http.dependency_unavailable` with the cause. A statement's own failure stays 500.

**Why.** An outage answered 500 `internal_error`, so clients could not tell "retry shortly" from
a bug.

## D34. Rows and batches page by what they served

**Decision.** Browse batch cursors and row cursors carry an 8-hex digest of every row or item
served so far; the next page is the first ones not served, in the current order. They keep the
served count beside the digests, so a server that reads only offsets still pages during a
rollout, and an offset-only cursor is still accepted. A search cursor that does not decode answers
`validation_failed` (it restarted at page one before).

**Why.** Offsets skipped a row when one before it disappeared (My List emptied between batches)
and repeated an item when one was added in front.

## D35. A view is a profile's minute of a title that day; dislikes per row

**Decision.** The rollup sums a profile's credited seconds over all its sessions of a title that
day; 60 s make one view (it counted single sessions, so two 40-second sessions were none, unlike
RECOMMENDATIONS.md). Disliked titles leave every suggested row; Top 10 (a chart) and My List
(the member's own picks) keep them (RECOMMENDATIONS.md, "Dislikes").

## D36. Nothing in flight is shared between requests

**Decision.** Caches in `packages/core` and `packages/http` keep settled values only: the
catalog, popularity and showcase caches, imported HMAC keys, the timing-equaliser hash and the
rendition map. Concurrent first requests each do the work.

**Why.** On Workers a promise created by one request must not be awaited by another: if the
first request is cancelled its waiters can hang (`packages/db/test/workerd/media-cancel.test.ts`).

## D37. zod is imported as a namespace

**Decision.** Shared packages import zod as `import * as z from "zod"`
(`packages/core/test/zod-import-shape.test.ts`). `import { z }` binds zod's own namespace object,
which esbuild keeps whole with every locale.

**Why.** About 260 KiB of the Worker bundle were zod locales nobody uses. Same API, same
messages. `apps/edge/src/env.ts` still imports `{ z }`; changing that one line drops the locales
from the Worker (measured with esbuild: 811 → 470 KiB, locales 258 → 3 KiB).

## D38. Every route's rate-limit policy exists at composition

**Decision.** `DEFAULT_RATE_LIMITS` in core is the one table of defaults, typed over every policy
the contract names; `loadCoreConfig` and `createApp` refuse (`ConfigError`) a table missing or
invalid for any policy. A runtime built from an incomplete table fails at startup, not with a 500
on the first limited request.

## D39. An empty body is no body where the body is optional

**Decision.** On routes with an optional body an empty or whitespace-only body is absent,
whatever `Content-Type` and `Content-Length` say; anything else is parsed and validated.

**Why.** Clients that send `Content-Type: application/json` on every request got 400 for a
body-less `DELETE /playback/sessions/:id`.

## D40. The API docs page and its CSP agree

**Decision.** `/api/docs` keeps its strict policy (scripts by nonce, no `'unsafe-eval'`); a
nonce'd inline script sets zod's `jitless` before the reference bundle loads, so the zod copy in
it never probes `Function("")` (the only dynamic code in the bundle), which the policy refused and
the browser reported. An http test checks every script and link on the page against the policy
served with it; only a browser can prove zero violations at runtime.

## D41. A PostgreSQL shutdown fails requests; it never ends the process

**Decision.** Every pooled `pg` client gets an `error` listener of its own when it connects (once,
so reuse never doubles it). pg-pool listens only while a client is idle in the pool; a lent client
had no listener, so a server's `FATAL 57P01` (graceful shutdown, failover, node drain) arriving
between two statements, or the socket closing after any FATAL, was an unhandled `'error'` event
and ended the process. A failed client is reported once (`onIdleConnectionError`, lent or idle)
and handed back to the pool marked as failed, so it is discarded at once rather than lent again
before its socket closes. A batch whose connection fails is not rolled back (the server already
ended the transaction with the connection, and nothing of it was applied); a batch whose
`ROLLBACK` fails discards its connection rather than return it inside a transaction. The request
answers 503 `service_unavailable` (D33). `packages/db/test/postgres-termination.test.ts`
terminates the backends of lent clients (idle between statements, and mid-transaction) and fails
without the listener.

**Not applicable to SQLite or D1.** `node:sqlite` is synchronous and in process: no socket, no
event, every failure is thrown by the call. A D1 query or batch is one request on the binding:
a failure rejects that call, and a batch is atomic on the D1 side.
