# @webflix/smoke: deployment conformance suite

A black-box suite that takes nothing but a base URL, drives the real HTTP surface the way a
browser would (cookie jar per device, CSRF header, Range requests, conditional requests,
playlists → segments), and reports precisely where a deployment deviates from the contract and
from the behaviour documented in `docs/BACKEND.md`, `docs/DECISIONS.md` and
`docs/RECOMMENDATIONS.md`.

The same suite runs against every mode: `dev` (Node), `k8s` (Postgres/Valkey/S3 behind a
gateway) and `cloudflare` (D1/KV/R2/Durable Objects/Queues). It is the acceptance test for the
k8s and Cloudflare deployments, and it is aimed at exactly the places where the modes differ
underneath: session revocation, atomic stream and rate-limit counters, read-after-write of
personal state, range reads from different blob stores, async/derived processing.

It only speaks HTTP: no database, no server internals, no third-party origins (an external
HLS URL is asserted, never fetched). Every response body is validated against the zod schemas
of `@webflix/contracts`, so contract drift fails the check that observed it.

## Running it

```sh
make smoke                                    # dev API, http://localhost:4000
make smoke TARGET=k8s                         # http://localhost:8080   (TARGET=cf: :8787)
make smoke BASE_URL=https://webflix.example   # any deployment
make smoke SMOKE_ARGS="--only identity,consistency --json smoke.json"
make smoke-list                               # the catalogue

node tools/smoke/src/cli.ts --base-url http://localhost:4000 [options]   # same thing
```

Point it at whatever origin users load: the SPA origin when a web build is served (then the
SPA-fallback check runs), or the API origin (API-only: that check is skipped, with the reason).

Exit status: `0` nothing failed, `1` a check failed (or something was skipped with
`--fail-on-skip`), `2` usage error or nothing answers at the base URL.

| Option | Default | |
| --- | --- | --- |
| `-u, --base-url <url>` | `$SMOKE_BASE_URL` | Origin to test |
| `--only <ids>` / `--skip <ids>` | all | Comma-separated ids, prefixes (`identity`) or globs (`media.*`, `*range*`) |
| `--tag <tags>` | | `consistency`, `exclusive`, `demo`, `ip-limit` |
| `--list` | | Print the catalogue (respects filters) |
| `--json <file>` | | Write the JSON summary (`-` for stdout; the text report then goes to stderr) |
| `--expect-fail <ids>` | | Known failures: reported `XFAIL` and do not fail the run; a passing one is `XPASS` |
| `--fail-on-skip` | off | Any skip fails the run (use when the target is expected to support everything) |
| `--rate-limits <spec>` | `auto` | `auto` detects; `strict` / `relaxed` pin the documented profiles; `profile-pin=10/60,auth=20/60` pins custom limits (policies: `auth`, `signup`, `email-lookup`, `profile-pin`, `payment`, `auth-email`, `playback-start`) |
| `--no-ip-exhaustion` | off | Never exhaust IP-keyed limits (sign-in, sign-up, email lookup): for a deployment shared with people behind the same address |
| `--concurrency <n>` | 4 | Checks running at once |
| `--parallelism <n>` | 8 | Concurrent requests per consistency fan-out |
| `--repeat <n>` | 3 | Rounds per consistency check |
| `--burst <n>` | 80 | Size of one rate-limit measuring burst (bursts repeat up to 5× until something is limited) |
| `--timeout <ms>` | 120000 | Per check (some checks declare longer) |
| `--request-timeout <ms>` | 20000 | Per request |
| `--eventual-timeout <ms>` / `--poll-interval <ms>` | 30000 / 500 | Budget and interval for effects polled with `eventually` |
| `--demo-email`, `--demo-password` | documented demo | The seeded demo account (read-only checks) |
| `--media-title <id>` | discovered | Title for the packaged-media checks |
| `--verbose`, `--no-color`, `--run-id <id>` | | Every request, plain output, tag for emails and request ids |

As a library:

```ts
import { allChecks, parseCli, runChecks } from "@webflix/smoke";
const { options } = parseCli(["--base-url", "http://localhost:4000", "--only", "identity"]);
const report = await runChecks(allChecks, options, { onResult: (result) => console.log(result.id, result.outcome) });
```

## Output

One line per check as it finishes (`PASS`, `FAIL`, `SKIP`, `XFAIL`, `XPASS`, duration, title);
under a failure: what was expected, what was observed, any extra detail (zod issues for
contract drift, per-request tallies for fan-outs) and the request that observed it (method,
path with media tokens shortened, status, the `X-Request-Id` to grep in server logs, request
and response excerpts). Then the target facts the suite detected, counts per area, the failed
and skipped checks with their reasons, and the totals.

The JSON summary (`--json`) is the `RunReport` type in `src/types.ts`: run id, base URL,
timings, detected target facts, options, counts, `ok`, and per check `outcome`, `reason`
(skips), `failure` (`message`, `expected`, `observed`, `details`, `request` with headers and
bodies), `notes` (measurements, latencies, throttling) and the number of requests made.

A skip always carries its reason and is listed separately; it is never counted as a pass.

## What it detects about the target

Requirements are detected from outside, never assumed from the mode name:

| Fact | How | Checks that need it |
| --- | --- | --- |
| Web build served | `GET /` answers `text/html` with scripts (a Vite dev server, recognised by `/@vite/client`, skips `ops.asset-miss`) | `ops.spa-fallback`, `ops.asset-miss` |
| Packaged media | starting playback yields a same-origin `/media/{token}/…` manifest (titles with preview clips or real artwork are tried first; at most 24 probes) | the `media.*` checks on segments, `plans.quality-cap`, `media.quality-cap` (which also needs a title with a rendition above 720p) |
| External HLS fallback | starting playback yields an absolute third-party manifest URL | `media.external-fallback` |
| Demo account | signing in as the documented demo account | `browse.demo-first-load`, `identity.demo-account-protected` |
| Rate-limit profile | a concurrent burst of PIN attempts on a locked profile of a fresh account (`profile-pin` is keyed by account, so measuring it affects nobody else; locking the profile spent one unit, a password check, which is counted) compared with the documented values: strict 5/min, dev 60/min. `payment` (10 per 10 min), `auth-email` (10 per 15 min) and `playback-start` (60/min) are the same in both profiles | `ratelimit.strict-defaults`, `consistency.rate-limit-exact`, `plans.payment-method`, `ratelimit.playback-start`, `ratelimit.auth-email` |
| Popularity diagnostics | `GET /titles/:id/popularity` answers (absent when `WEBFLIX_ENV=production`, which the OpenAPI document tells apart from a missing route) | `pipeline.credit-bounded`, `pipeline.popularity-view` |
| Probes exposed | `/healthz` answers (k8s routing keeps probes internal: skipped there) | `ops.health` |

## Effect on the target

- Every run creates its own accounts with unique addresses
  (`smoke-<run>-<tag>-<n>@smoke.webflix.test`), so runs repeat and can run concurrently against
  a shared deployment. The demo account is only read (its session gets a profile selected;
  `identity.demo-account-protected` only tries changes an unprotected server would refuse for
  another reason, so it changes nothing even there).
  About 30 sign-ups (profiles are pooled four to an account where per-profile isolation is
  enough) and 40 sign-ins per run; accounts are not deleted (there is no API for it).
- Under strict limits (sign-up 5/min, sign-in 10/min per client address) the suite waits out
  `rate_limited` answers like a well-behaved client and notes each wait under the check:
  a full run takes about 5 minutes, against about 100 seconds in dev mode, most of it
  `pipeline.popularity-view` playing a title for a minute (it starts first, in parallel).
- The popularity checks take titles from the end of the catalogue that no other check of the
  run touches; a concurrent viewer of the same title on a shared deployment would make the
  "exactly one view" count read two.
- Sign-ins are also limited per email address (10 per 15 min) for browsers the account does
  not know. The suite's extra devices of an account carry the account's "known device" cookie
  (from its sign-up), as browsers that signed in before would, so only `ratelimit.auth-email`
  spends that budget, on an account of its own.
- At the end, `identity.signin-rate-limit` (and, on strict targets, `ratelimit.strict-defaults`)
  deliberately exhaust the sign-in, sign-up and email-lookup budgets of the address the suite runs
  from, alone and after everything else. A second run started right away begins throttled.
  Use `--no-ip-exhaustion` if other people share that address.
- Packaged-media checks keep one playback session alive with heartbeats for the duration of the
  run and stop it at the end.

## Check catalogue (95)

`[c]` consistency fan-out · `[x]` exclusive (runs alone, last) · `[d]` demo account.

**ops (11)**: `ops.health` liveness/readiness when exposed · `ops.openapi` OpenAPI 3.1 lists every
route of the contract · `ops.docs-page` docs load only same-origin scripts; CSP allows no foreign
script origin · `ops.security-headers` nosniff, frame DENY, referrer policy, COOP/CORP, CSP, HSTS on
https, `no-store` and `Vary: Cookie` on the API · `ops.request-id` echoed when valid, replaced when
invalid, equal to `problem.requestId` · `ops.problem.unknown-route` unknown API routes are a
`not_found` problem · `ops.problem.missing-resources` unknown title/genre/row/blob, garbage media
token · `ops.problem.validation` params/query/body issues (all at once), malformed JSON, wrong
content type · `ops.problem.payload-too-large` a 1 MiB+ body · `ops.spa-fallback` deep links get the SPA; API, `/media`, `/cdn` misses
never do · `ops.asset-miss` the entry script is immutable JavaScript; missing `/assets/*.js`,
`.css` and a root image answer 404, not HTML, `no-store` and never immutable or a positive
`max-age`; navigating to a missing build file is a 404, to a client route the HTML shell
(skipped on a Vite dev server).

**identity (13)**: `identity.email-status` · `identity.signup` approved card, cookie attributes
(HttpOnly, SameSite=Lax, Path=/, Secure + `__Host-` on https), duplicate email ·
`identity.signup.declined-cards` declined / insufficient funds / expired, nothing created ·
`identity.signin` persistent vs browser-session cookie · `identity.signin.wrong-password` (same
answer for unknown emails) · `identity.session-bootstrap` anonymous, `unauthenticated`,
`profile_required`, profile bound per session, dead cookies cleared · `identity.signout` revoked
server-side (old cookie replayed) · `identity.signout-everywhere` [c] other sessions refused on the
very next request, from every instance · `identity.devices` current flag, labels, revocation at
once · `identity.csrf` missing/wrong header refused and nothing changes ·
`identity.signin-rate-limit` [x] limited, correct shape and `Retry-After`, no request admitted in the
meantime, recovers (from a browser the account knows, so the per-email limit is not what it
measures) · `identity.demo-account-protected` [d] `account.isDemo`; email, card and a new profile
refused with `demo_account_protected` · `identity.password-byte-limit` a password over 1024 bytes
after NFKC is a `validation_failed` on `password` and creates nothing.

**profiles (10)**: `profiles.crud` defaults, edit, partial settings, lowering vs raising the ceiling,
delete, last profile · `profiles.five-profile-cap` · `profiles.kids` 7+ cap, password for loosening ·
`profiles.kids-off-needs-password` the documented rule on its own · `profiles.maturity-filtering`
7+ and 13+ profiles: browse, genres, search, detail, similar, episodes, playback, My List, ratings ·
`profiles.pin` set/clear needs the password, required/invalid/accepted, PIN never returned ·
`privileges.kids-profile` a kids session cannot add (even with the password), rename another,
loosen itself, delete the locked profile, read the account, change the plan, cancel or sign out
everywhere (`unrestricted_profile_required`); it renames itself, sees `parentalControls`,
switches and signs out · `privileges.gate-and-locked` at the gate a new profile needs the password
while controls are in use; a locked profile needs its PIN (or the password) to be renamed,
restricted or deleted · `privileges.account-holder` account routes answer `profile_required` at
the gate and `unrestricted_profile_required` from a 13+ profile · `privileges.pin-locks-other-devices`
a PIN set on one device sends another device on that profile back to the gate.

**browse (16)**: `browse.views` billboard (null for new-popular), typed rows, ranks ·
`browse.row-batches` cursors, no repeated rows, tampered cursor · `browse.row-pagination` next pages
without overlap, `limit`, unknown row · `browse.genres` every sort (a-z collation, z-a = reversed,
newest/oldest by year), type filter, pagination, unknown/invalid slug · `browse.title-detail` ·
`browse.episodes` numbering and counts, bad season, movie · `browse.similar` ·
`browse.search` prefix, case, added and stripped diacritics, people and genre suggestions, empty
state, a long query cut and searched, validation · `browse.demo-first-load` [d] billboard with a match score, ≥ 12 rows of ≥ 6
kinds, Top 10 of 10 distinct, cards scored · `browse.showcase` the public showcase: guests, ≤ 13+,
the catalog's versioned artwork, `public` caching without `Vary: Cookie`, 304 on revalidation,
the same document for a member · `browse.badges` a chart-topper being watched: no badge on the Top 10
row, only "new episodes" in Continue Watching, no "new" in New Releases or on the played title,
at most two badges per row in every view, every `top10Rank` equal to the view's Top 10 row · `browse.video-quality` `bestVideoQuality` of the packaged session equals
the tier of its master playlist's best rendition, matched on detail and card; none for external
media · `browse.search-any-script` long CJK, Cyrillic, astral-plane, emoji and combining-mark
queries answer 200 · `browse.search-cursor-invalid` a cursor the server did not issue is
`validation_failed` · `browse.batches-stable` My List emptied between batches: every row of the
plan is served exactly once · `browse.durations-agree` a packaged movie's card and detail
runtime, a packaged episode's listed runtime, and their playback sessions agree within a second;
series carry no runtime.

**library (7)**: `library.my-list` round trip, newest first, idempotent, pagination ·
`library.ratings` love/dislike/clear in viewer state · `library.dislikes-leave-rows` one title
disliked from each personalised row of every view, then none appears anywhere (Top 10, a chart,
and My List, the member's own picks, keep them by design) · `library.continue-watching` heartbeat → row, detail progress, play target,
resume point, play-from-start, hide until watched again · `library.continue-watching-series` a
finished episode then two seconds of the next: the series stays at the next episode from 0, and
the row, the home row, the play target and Play agree; a series sampled for 3 s stays out ·
`library.history` newest first,
pagination, removal clears progress · `library.notifications` a new profile opens with no backlog: at
most three earlier arrivals, already read, newest first; read-all and validation.

**playback and media (16)**: `playback.session` shape, plan cap, series play target and next
episode, one stream per device, errors, stop and heartbeat after stop ·
`playback.release-final-position` a release carrying the final position records it and frees the
one Basic screen in one request (no heartbeat sent); another profile cannot report on the
session; without a body the release stays idempotent · `media.manifest` [c]
master/variant playlists, relative URIs, variants under the plan cap, master served on every
instance while the slot is held · `media.range-requests` full, `0-99`, `100-`, `-50`, clamped end,
two unsatisfiable (416 + `Content-Range: bytes */N` + problem `size`), reversed range ignored,
HEAD, If-Range · `media.segment-integrity` init + first/second/middle/last segment of every
rendition are complete ISO-BMFF (or MPEG-TS): catches truncated uploads, which range semantics
cannot see · `media.conditional-requests` 304 for strong, weak and listed tags on segments and the
master · `media.token-tampering` tampered, truncated, wrong-asset tokens → `media_token_invalid`,
not cached · `media.subtitles` / `media.trick-play` when advertised · `media.cdn` immutable caching,
304, ranges, query string not part of the key (when packaged artwork or previews are advertised)
· `media.external-fallback` shape only, never fetched · `media.playlist-after-stop` 410 for
playlists, segments still valid (DECISIONS D1) · `media.quality-cap` on Basic, the playlist and
first segment of a rendition above 720p (found through a Premium session) answer
`media_quality_restricted`, not only absent from the master · `media.invalid-key-paths`
backslash, control characters and over-long keys never reach a blob store: the API answers its
404 `not_found` under `/cdn` and `/media`; a gateway may refuse control characters first (Envoy:
an empty 400 for a NUL), which passes as any 4xx without content; a gateway's redirect for the
backslash is followed and the final answer must be the API's 404; never a 5xx ·
`playback.release-empty-body` a release with `Content-Type: application/json` and an empty or
blank body is a 204 · `playback.signout-stops-playback` a device playing on Basic, then "sign out
of all devices" from another: the player's next heartbeat (401), playlist (410) and start (401)
are refused and another device starts on the freed screen.

**plans (6)**: `plans.catalogue` · `plans.stream-limit` Basic across devices, 409 lists the active
device, release on stop and on sign-out · `plans.change-effects` downgrade ends the newest extra
stream and caps quality, upgrade adds screens, declined card changes nothing ·
`plans.cancel-resume` · `plans.quality-cap` Basic master playlist ≤ 720p (skipped when the
packaged asset has nothing taller) · `plans.payment-method` `PUT /account/payment-method`: declined,
insufficient funds and expired cards change nothing, a bad CVC is a validation problem, an
approved card is stored as exactly brand, last four and expiry, the membership is untouched,
and the account's card verifications stop at the `payment` limit exactly (plan changes with a
card included, without a card not).

**consistency (6)**, all [c]: `consistency.stream-limit` devices starting at once on a 1-stream
plan: exactly one wins, every round; retries refused and heartbeats accepted from every instance ·
`consistency.session-and-profile` a new session and profile switches seen by every following
request · `consistency.library-read-after-write` My List and ratings · `consistency.profile-cap-race`
concurrent creates never exceed five · `consistency.rate-limit-exact` a burst of PIN attempts admits
exactly the limit (plus refill during the burst) · `consistency.rate-limit-monotonic` once
limited, no PIN attempt is admitted before `Retry-After`.

**ratelimit (6)**: `ratelimit.profile-pin.recovery` wrong PINs until limited; another locked
profile from another device is limited too (per account), an unlocked profile stays selectable,
a neighbour account is not affected, recovers after `Retry-After` ·
`ratelimit.profile-pin.unlocked-free` a burst of unlocked switches larger than any documented
limit and PIN-less requests for a locked profile are all admitted, and the PIN budget is
untouched afterwards · `ratelimit.strict-defaults` [x] on strict targets: email lookup, sign-in
and sign-up admit no more than 20, 10 and 5 (from a browser the account knows) ·
`ratelimit.credential-budget` wrong passwords on `PATCH /profiles/:id` are limited, and the right
PIN then waits too (one budget per account) · `ratelimit.playback-start` a burst of starts on one
account stops at the documented limit · `ratelimit.auth-email` [x] wrong guesses at one account
from unknown browsers stop at 10; a new browser with the right password waits; the account's own
browser signs in (paced one every 7 s, under the per-address limit, so each 429 is told apart:
about 100 s).

**pipeline (4)**: `pipeline.watch-signals` finishing a movie on a cold profile: history, completed
progress, match scores appear, a "Because you watched" row, out of Continue Watching (latency
reported) · `pipeline.series-advance` finishing an episode offers the next one at 0 in Continue
Watching, the play target and Play · `pipeline.credit-bounded` thirteen heartbeats in a burst
claiming 66 s, then a release: the title's daily counters credit no more than the time that
passed and count no view (a second profile playing the title afterwards proves the counters
include the release) · `pipeline.popularity-view` [slow] a minute of playing at real pace, then
a release with the final position: the title's views for the day move by exactly one, with
60 s to the elapsed time credited. Both read `GET /titles/:id/popularity` and skip in
production.

## Known limits

- **The credit bound is checked at the counters too.** `pipeline.credit-bounded` (a burst of
  heartbeats is credited the seconds that passed and counts no view) is a property of the
  per-title counters behind Top 10 and Trending; production exposes no surface that shows them
  (DECISIONS.md D21), so it skips there. Positions, Continue Watching and history are not
  credit, so they cannot stand in. The repository contract suite enforces the bound on every
  dialect.
- **Popularity is checked at its counters, not its ranks.** A view counts once per profile per
  day after 60 s of credited watching, against a synthetic baseline of tens to hundreds of views
  per title per day, so a run cannot move Top 10 or Trending measurably. The suite reads the
  per-title daily counters those rows are computed from (`GET /titles/:id/popularity`, not
  served in production, where the two pipeline checks skip with that reason).
- **Per-instance limiters behind a perfectly even round-robin** admit `k × limit`, which looks
  like a larger shared limit. The suite compares the measured burst with the documented values
  (5 strict, 60 dev); with custom limits, pin them with `--rate-limits`.
- **Not observable from one client** and covered by package tests instead: IPv6 /64 keying (the
  suite has one address), the deletion of expired sessions, concurrent profile edits of
  different fields, a heartbeat racing the release on Postgres, a database outage answering 503,
  two short sessions adding up to one view, and the rollup of a session replaced on the same
  device (docs/DECISIONS.md D27–D35).
- **Integrity is sampled**: four segments per rendition, not every object.
- **L4-only balancing** with keep-alive can pin a client's requests to one instance; the
  consistency checks assume per-request (L7) balancing, as a Gateway API route or Workers give.

## Adding a check

Checks live in `src/checks/<area>.ts` and are registered in `src/checks/index.ts`.

```ts
{
  id: "library.my-check",                      // stable: used by --only/--skip/--expect-fail
  area: "library",
  title: "One line saying what conforming behaviour looks like",
  needs: [needs.packagedMedia],                // optional: detected requirements (src/needs.ts)
  tags: ["consistency"],                       // optional
  async run(ctx: CheckContext) {               // annotate ctx: narrowing after ctx.skip needs it
    const viewer = await ctx.env.isolatedViewer("my-check");      // own profile and device
    const detail = await succeeds(() => viewer.agent.api.getTitle({ params: { id } }), "detail");
    equal(detail.viewer.inMyList, false, "inMyList before adding");
    await rejects(() => viewer.agent.api.addToMyList({ params: { titleId: "t-nope" } }), "not_found", "unknown title");
    problem(await viewer.agent.fetch("/api/v1/…"), "validation_failed", "raw request");
    if (!supported) ctx.skip("why the target cannot support this");
  },
}
```

- Talk to the target only through agents: `ctx.agent(label)` for a fresh browser,
  `agent.api.*` for the typed, validating client, `agent.fetch(path)` for raw requests (media,
  headers, malformed input). Agents refuse third-party origins.
- Isolation: never mutate shared state. Use `ctx.env.signup(tag)` for account-level state (plans,
  devices, profiles), `ctx.env.isolatedViewer(tag)` for per-profile state (library, playback),
  `ctx.env.browseViewer()` and `ctx.env.catalog()` only for reads, the demo account only for reads.
- Assertions (`src/expect.ts`) carry expected/observed and the request: `succeeds`, `rejects`
  (narrows the problem extensions), `problem`, `status`, `header`, `equal`, `check`, `fail`.
- Anything eventual is polled with `ctx.eventually(what, probe, { timeoutMs })`, never a sleep.
- Anything the target may legitimately lack is a `needs` requirement or a `ctx.skip(reason)`; a
  check that would pass vacuously skips instead.
- Run `pnpm --filter @webflix/smoke test` (the runner, parsers and HTTP agent have unit tests),
  then the check against a real target.
