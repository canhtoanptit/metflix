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

Milestone 2's journeys (docs/BLUEPRINT-M2.md §12) are driven through the three local stand-ins a
non-production deployment serves, exactly as a browser would use them: the development OpenID
issuer at `/dev-idp/*` (its sign-in page answered with a persona or a typed address, Apple's
auto-submitting form post replayed, faults ticked on the page), the fake payment provider's form
at `/_pay/*` (its JSON confirmation, the same capability a client secret gives the page) with a
test clock per customer (`POST /diagnostics/billing/clock`), and the local mailbox
(`GET /diagnostics/mailbox`) for emailed links. Staff tokens come from the development issuer's
staff realm through the console's authorisation code flow with PKCE. Where a deployment does not
serve a stand-in (production configuration, Stripe instead of the fake), the journeys that need
it skip and say what would make them runnable (below).

**Member accounts.** No card ever reaches Webflix (principle 4), so a member account comes about
only through a checkout at the payment provider (besides the seeded demo account, which is
shared and cannot change, and staff, who extend an existing membership). The suite signs up
(`{email, password}`) and checks out with one of the fake provider's labelled test cards (a card
of its own: the trial, nothing charged). A check that only needs an account (sign-in, profiles,
PINs, privileges, My List, ratings, notifications, browsing, rate limits, experiment assignment)
uses an account without a membership (`isolatedViewer(tag, { member: false })`, `bareSignup`).
On a deployment without the fake provider (production configuration: provider `none` or Stripe)
no member can be made: the checks that need one (they play, or bill) skip with that reason
("needs a member account, and a member comes about only through a checkout…"). On a
no-provider dev API that is 37 checks besides the 25 that drive the fake provider itself; 85
pass there, 0 fail.

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
| `--promo-code <code>` | the fake provider's standing `WEBFLIX50` | A promo code the deployment honours for the Standard plan (`billing.promo-code.applied`): needed only where the standing code is absent (another `WEBFLIX_PAYMENTS_FAKE_PROMOTIONS`) |
| `--export-wait <ms>` / `--export-wait-max <ms>` | 300000 / 1200000 | Batch-mode data export: how long to wait for a first round of the deployment's `export-events` job, and the longest wait once the job has deferred the request (its grace) |
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
| Rate-limit profile | a concurrent burst of PIN attempts on a locked profile of a fresh account (`profile-pin` is keyed by account, so measuring it affects nobody else; locking the profile spent one unit, a password check, which is counted) compared with the documented values: strict 5/min, dev 60/min. `payment` (10 per 10 min), `auth-email` (10 per 15 min), `playback-start` (60/min), `promotion` (10 per 10 min) and `billing` (30 per 10 min) are the same in both profiles, so their checks need no measurement (`--rate-limits promotion=…,billing=…` pins others) | `ratelimit.strict-defaults`, `consistency.rate-limit-exact`, `plans.payment-budget`, `ratelimit.playback-start`, `ratelimit.auth-email`, `billing.promo-budget`, `billing.provider-budget` |
| Popularity diagnostics | `GET /titles/:id/popularity` answers (absent when `WEBFLIX_ENV=production`, which the OpenAPI document tells apart from a missing route) | `pipeline.credit-bounded`, `pipeline.popularity-view` |
| Probes exposed | `/healthz` answers (k8s routing keeps probes internal: skipped there) | `ops.health` |
| Development issuer | `GET /auth/providers` offers the provider and `/dev-idp/{provider}/.well-known/openid-configuration` answers; a start that redirects to a real issuer skips the journey | `identity.oidc.*`, `identity.password-reset.drops-identities`, `billing.member-journey` |
| Local mailbox | `GET /diagnostics/mailbox` answers (memory or outbox sender, not in production) | `identity.verify-email`, `identity.password-reset*`, `identity.oidc.auto-link` (and the emails the billing, export and support checks assert when it is there) |
| Fake payment provider | `GET /billing/config` names `fake` and `/_pay/api/cards` answers; `none` (production without a provider) and `stripe` skip with their reason | every `billing.*` but `billing.provider-config`, `staff.refund` |
| Staff issuer | `/dev-idp/staff` discovery answers and the staff API accepts its token (`GET /me`) | every `staff.*`, `experiments.*` |
| Events read-back | `GET /diagnostics/events` answers for a signed-in account | `privacy.events`, `privacy.kids-profile`, `privacy.consent` |
| Consent mode | `GET /privacy/consent` → `mode`; the consent check asserts the mode the deployment runs | `privacy.consent` (and `privacy.events`, `privacy.kids-profile` skip in `off`) |
| Cooling-off | the `scheduledFor` of the check's own deletion request; above 60 s it is cancelled and the check skips | `privacy.deletion.erasure` |
| Labelled cards | the fake provider takes `<test card>:<label>`, a card of that kind with a fingerprint of its own (a card that never had a trial); a provider that refuses one skips the check with that reason | `billing.trial-*`, `billing.member-journey`, `billing.dunning`, and the spent card below |
| Privacy terms | `GET /privacy/requests` → `terms`: the export mode (`inline` or `batch`) and its typical time, the cooling-off period (the erasure check skips above 60 s without creating a request); in batch mode the job's rounds and deferrals are read from the audit log | `privacy.export`, `privacy.export-operator`, `privacy.deletion.erasure` |
| Service client | the staff realm's `webflix-jobs` client-credentials grant (published development secret) | `staff.service-account` |
| Recommendation run | `GET /system/recommendations` (`activeModel`; fresh while `expiresAt` is ahead; a demo run's id ends `-de00de00`) | `experiments.recommendation-status` (any run), `personalisation.consent` (a fresh one) |

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
- The per-account budgets (`promotion`, `billing`: ten minutes) are spent on accounts of the
  checks' own (`billing.promo-budget`, `billing.provider-budget`), so nothing else is throttled
  and a rerun starts afresh.
- Milestone 2 checks add about 60 accounts per run (most signed up without a card, a dozen
  through the development issuer with typed addresses `smoke-<run>-…@smoke.webflix.test`), a
  customer at the fake provider for each checkout, and messages in the local mailbox for those
  addresses. Time passes only on each customer's own test clock, so no other account (the demo
  account included) sees it move.
- Three of them change deployment-wide state for a few seconds and therefore run `exclusive`
  (alone, after everything else, before the IP-exhausting checks): `billing.provider-events`
  sets the fake provider's webhook delivery policy (unruly, then outage) and restores what it
  found; `staff.curated-row` publishes a collection on the home page and deletes it;
  `experiments.assignment` starts two experiments in layers of their own (`smoke-profile-<run>`,
  `smoke-device-<run>`, no other experiment shares them) and completes them when the run ends;
  where a status change is scheduled ahead (`WEBFLIX_EXPERIMENTS_PROPAGATION_SEC`, 60 s on
  Kubernetes and Cloudflare) they keep assigning their own keys for that long after the run,
  which touches no other experiment. Two suites must not run at once against one deployment (the delivery policy is
  shared).
- **Trials use labelled cards.** One trial per card fingerprint (§5.4), deployment-wide, so a
  check that needs a first trial confirms a labelled card no run has used
  (`mastercard:smk-<run>-converts-<random>`); the trial checks pass on every rerun against one
  database. Checks that need the opposite (a checkout that stops at its first payment) share one
  labelled card per run whose trial a throwaway account takes first (it stays trialing).
- Staff tokens (each persona's, and the jobs' service-account token) are minted once and
  renewed when less than a minute (or a quarter of a short lifetime) remains; every staff call,
  including one after a long wait such as a batch export's, asks for the current token. The run's
  target facts count the mints and renewals.
- Federated sign-ins are paced within the `oidc` budget (the start and the callback each count):
  a strict deployment (30 per minute per address) gets at most 14 sign-ins a minute from the
  suite, because a callback refused by the limit can only redirect with `?oidc=failed`.
  Password resets and verification requests spend the `email-send` budget (strict: 10 per 15
  minutes per address): a second strict run within 15 minutes waits.

## What to expect per deployment

Observed runs, for telling a regression from the deployment's shape:

- **Dev API configured for the whole suite** (below, the demo run imported): every check passes
  but five Milestone 1 checks that cannot apply (no web build served, no external-fallback title,
  two strict-limit checks under relaxed limits); about 3 minutes. Without the demo run,
  `experiments.recommendation-status` and `personalisation.consent` skip too (no run served).
  `privacy.export-operator`'s batch cases need `WEBFLIX_EXPORT_EVENTS=batch` (a second dev API).
- **Local Worker** (`make cf-dev CF_CRON_EVERY=30 CF_JOBS_EVERY=10`, 30 s cooling-off): the same,
  with `privacy.export` completed by the batch job loop.
- **Kubernetes, production configuration** (Keycloak as the staff issuer, mail over SMTP to a
  mail catcher, no payment provider): the checks that play or bill skip (no member can be made),
  the account-only ones pass, and the Milestone 2 ones skip,
  each with its reason (no development issuer, no mailbox, Keycloak tokens, a 14-day cooling-off,
  no read-back, and for billing: the deployment has no payment provider, `GET /billing/config`
  answering `none`). `billing.provider-config` runs there and asserts what a deployment without a
  provider must answer.
- **Kubernetes, conformance variant**: `ops.health` skips (the probes are on the ops port, not
  routed through the gateway: correct). With several replicas, a checkout stranded by a race
  between the provider's webhook and the browser's confirmation is a product defect being fixed;
  experiment status changes now take effect at one stated instant (`statusChangeAt`), which the
  assignment check waits for, probing each experiment only until 2 s before its own instant
  (docs/KUBERNETES.md §9.11, K13).
- Strict limits make a run long (about 16 minutes on the cluster): staff and job tokens (five
  minutes) are renewed as they near expiry, so the late staff checks keep working. The promo-code
  and provider budgets are the same in both profiles and per account, so their checks behave
  alike on strict and relaxed targets; the extra password resets and verification links of
  `identity.oidc.prehijack` and `identity.oidc.address-change` spend the `email-send` budget
  (strict: 10 per 15 minutes per address), where a strict run waits rather than fails.
- **Batch exports** (Kubernetes, Cloudflare): `privacy.export` completes only through the
  deployment's own `export-events` job (it skips naming the two fixes when none runs);
  `privacy.export-operator` plays the job's part itself for one request of its own (deferred,
  then failed: still listed, still one export at a time), racing a real job that might finish
  that request first.

## What a deployment must provide for nothing to be skipped

For the platform engineers who run the suite against the Worker and kind. Each item is what the
suite detects; without it the named checks skip with this reason, never pass.

| Setting | Why | Checks that skip without it |
| --- | --- | --- |
| `WEBFLIX_ENV` other than `production` (`development`) | mounts `/dev-idp/*`, `/_pay/*` and the diagnostics routes (mailbox, events read-back, billing clock); a production configuration answers `not_found` there | almost every milestone 2 check |
| `WEBFLIX_PAYMENT_PROVIDER=fake` (the default outside production) | test cards, the challenge page and the per-customer clock; the Stripe lane is `tools/stripe` | `billing.*`, `staff.refund` |
| `WEBFLIX_EMAIL_SENDER=memory` (one process) or `outbox` (several replicas or isolates: the database outbox every instance reads) | the mailbox read-back; `memory` behind more than one replica or isolate shows each instance's own mail only | `identity.verify-email`, `identity.password-reset*`, `identity.oidc.auto-link` |
| No `WEBFLIX_OIDC_GOOGLE_*` / `WEBFLIX_OIDC_APPLE_*` client; `WEBFLIX_OIDC_PROVIDERS` including `google,apple` | the development issuer stands in only for a provider without a real client | `identity.oidc.*`, `billing.member-journey` |
| `WEBFLIX_STAFF_VERIFIER=oidc` with the development staff issuer (no `WEBFLIX_STAFF_ISSUER`, or the development one) | staff tokens the suite can mint | `staff.*`, `experiments.*` |
| `WEBFLIX_PUBLIC_ORIGIN` on the same host as the base URL (any port) | the issuer and the callbacks are built from it; the suite follows another port of the same host (a browser shares cookies across ports) but not another host | federated checks |
| A shared `WEBFLIX_DEV_IDP_SECRET` across replicas and isolates (the derived default is shared) | codes minted by one instance are redeemed by another | federated checks fail (not skip) without it |
| `WEBFLIX_DELETION_COOLING_OFF_SEC` ≤ 30 and a scheduler tick ≤ 30 s (`WEBFLIX_SCHEDULER_INTERVAL_SEC` on Node, minimum 5; the Worker's cron, and on `wrangler dev` its scheduled handler triggered) | the erasure runs on the scheduler's sweep after the cooling-off period | `privacy.deletion.erasure` |
| The fake provider's standing promo code (`WEBFLIX_PAYMENTS_FAKE_PROMOTIONS`, default `WEBFLIX50`), or `--promo-code` | the code the promo journey applies | `billing.promo-code.applied` |
| Batch exports (`WEBFLIX_EXPORT_EVENTS=batch`, the default on Kubernetes and Cloudflare): the pipeline's `export-events` job running on a schedule shorter than `--export-wait` (5 minutes), with a grace that fits `--export-wait-max` (20 minutes; the job's own default grace is 15 minutes), posting to `POST /system/privacy/exports/results`. Locally on Cloudflare `make cf-dev CF_JOBS_EVERY=10` (or `make cf-export-events` by hand); on Node, `inline` where it is allowed | without a job a batch export never completes: the check skips naming both fixes; a job that runs and does not finish the export, or fails it, fails the check | `privacy.export` |
| The development staff realm's service client `webflix-jobs` (client credentials, roles admin and experiments) | a job's token for the operator routes | `staff.service-account` |
| An imported recommendation run (`make recs`, then `node apps/api/src/recs.ts import` on Node, `make cf-recs-import` on Cloudflare: the staff route refuses a run too large for one Worker invocation with `recommendation_import_too_large`), fresh for `personalisation.consent`; a demo run serves where no pipeline run is fresh (`node apps/api/src/recs.ts demo` on Node with the API's environment, `make k8s-recs-demo` on Kubernetes) | the served model's status; serving following consent and restriction | `experiments.recommendation-status`, `personalisation.consent` |
| `WEBFLIX_CONSENT_MODE` | the consent check proves the configured mode only: run once per mode to prove all three (`opt-in` default, `opt-out`, `off`) | `privacy.events` and `privacy.kids-profile` skip in `off` |

The local Worker under test: `make cf-dev CF_CRON_EVERY=30 CF_JOBS_EVERY=10` with a 30 s
deletion cooling-off (docs/CLOUDFLARE.md). A dev API configured for the whole suite (on a port
of your own):

```sh
PORT=5750 WEBFLIX_PUBLIC_ORIGIN=http://localhost:5750 WEBFLIX_DATABASE_URL=sqlite:/tmp/smoke/webflix.sqlite \
  WEBFLIX_BLOB_DIR=/tmp/smoke/blobs WEBFLIX_DELETION_COOLING_OFF_SEC=10 WEBFLIX_SCHEDULER_INTERVAL_SEC=5 \
  node apps/api/src/main.ts serve
# then, once it answers, a demo recommendation run (fresh for three days) so the learned-serving
# checks run, with the same environment:
WEBFLIX_DATABASE_URL=sqlite:/tmp/smoke/webflix.sqlite WEBFLIX_BLOB_DIR=/tmp/smoke/blobs \
  node apps/api/src/recs.ts demo
make smoke BASE_URL=http://localhost:5750
```

## Check catalogue (152)

`[c]` consistency fan-out · `[x]` exclusive (runs alone, last) · `[d]` demo account.

**ops (12)**: `ops.health` liveness/readiness when exposed · `ops.openapi` OpenAPI 3.1 lists every
route of the contract (member and staff API) · `ops.pending-routes` every operation the deployed
document marks `x-webflix-implementation: pending` (registered, not implemented yet: milestone 2
lands area by area) answers `501 not_implemented` naming its operation and area, to an anonymous
request without the client header; the pending operations are listed per area as notes · `ops.docs-page` docs load only same-origin scripts; CSP allows no foreign
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

**identity (13)**: `identity.email-status` · `identity.signup` an account with no membership
(`subscription`, `plan` and the card null, `membership.status` none), cookie attributes
(HttpOnly, SameSite=Lax, Path=/, Secure + `__Host-` on https), duplicate email; with no profile
yet `GET /account` answers (the account is its own holder), once a profile exists another device
at the gate gets `profile_required` ·
`identity.signup.card-data-refused` a sign-up or a plan change carrying a card is
`validation_failed` and creates nothing, no answer echoes the card, `PUT /account/payment-method`
is gone (404) ·
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

**profiles (11)**: `profiles.crud` defaults, edit, partial settings, lowering vs raising the ceiling,
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
a PIN set on one device sends another device on that profile back to the gate ·
`privileges.no-profile` an account with no profile is its own holder at the gate: account,
devices, identities and privacy requests answer; `PATCH /account` without the password is
`password_required` (nothing changes), an export and a deletion `reauthentication_required` until
a fresh proof (then accepted; the deletion kept); its first profile, a kids one, brings
`profile_required` back at the gate and `unrestricted_profile_required` on the kids profile.

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
stream and caps quality, upgrade adds screens, a plan change carrying a card is refused and
changes nothing · `plans.cancel-resume` · `plans.quality-cap` Basic master playlist ≤ 720p
(skipped when the packaged asset has nothing taller) · `plans.payment-budget` the account's
money-moving requests (the checkout's confirmation, every plan change) stop at the `payment`
limit exactly; another account is unaffected.

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

**identity, milestone 2 (13)**: `identity.oidc.google-signup` providers listed (public,
cacheable); the start is a code flow with S256 PKCE, state and nonce and the exact callback; an
HttpOnly transaction cookie (`__Host-`, Secure on https); `signed-up` back at `returnTo`, a
session for an account with no password, a verified address and membership `none`; the
callback replayed from another browser fails and signs nobody in; a password never signs in to
it; the next Google sign-in finds the same account · `identity.oidc.apple-form-post` Apple's
form post (no client header) signs up; `email_verified` sent as the string `"true"` counts;
SameSite=None; Secure on https; a rewritten `user` field (unsigned) changes neither the
account's address nor creates one for the address it names; a tampered state fails · `identity.oidc.linking` the address of
an unverified account (and the demo account's) is `link-required`; linking needs a fresh proof
(`reauthentication_required`, wrong password refused, the proof lasts 5 minutes); `linked`; the
identity then signs in to that account; `identity-in-use` for another account; unlinking leaves
the password working and the identity signing up anew; the only way in of a Google-only account
cannot be unlinked · `identity.oidc.unlink-sticks` an identity unlinked from an account with
the same verified address is `link-required` on its next sign-in (no silent relink), and only a
deliberate link by the proven account holder brings it back · `identity.oidc.refused-start` a refused start followed by a browser (a real navigation:
`Sec-Fetch-Mode: navigate`, sent through `node:http` because `fetch` replaces that header) is a
303 to its `returnTo` with `?oidc=failed&oidcError=<code>` (`unauthenticated`,
`reauthentication_required`; an off-site `returnTo` goes to `/`), while a script still gets the
problem document, and an accepted start still goes to the issuer · `identity.oidc.reauth` a
Google-only account is offered Google and not the password; a password is `password_required`
for it; the start asks `max_age=0`; a stale or missing
`auth_time` and another identity fail; a fresh sign-in (the page shown despite the issuer's
session) proves it for 5 minutes and stands in for the password (a first password set with it) ·
`identity.oidc.faults` eleven faults of the issuer's catalogue (alg none, HMAC key confusion,
embedded JWK, wrong issuer, audience, expired, nonce, tampered state, PKCE mismatch, a code of
another client, an unverified address) all `failed`, nobody signed in, no account created;
Cancel is `cancelled` · `identity.verify-email` the link's token is in the fragment, single use,
a forged one refused · `identity.oidc.auto-link` the address verified in the account's own
session, both sides verified: the Google sign-in links itself (the honest path) ·
`identity.oidc.prehijack` (security review H1) someone signs up with the owner's address and a
password, proves it and links an Apple identity of their own; the owner opens the verification
link signed out in another browser; Google with the address is `link-required` and signs nobody
in; the owner's reset from the mailbox answers 200 with a session for that account, the set-up's
session is refused, its password refused, its Apple identity gone (and signing in to something
else); Google then signs in to the account · `identity.oidc.address-change` verified in its own
session the account links Google; moved to a new address verified from a browser with no
session, Google with the new address is `link-required` · `identity.password-reset` the same 204
for an unknown address, a single-use link whose confirmation answers 200 with the session (the
account, at the profile gate, the profiles listed, a session cookie) and signs that browser in,
every other device signed out, the old password refused, the address verified, a security alert
· `identity.password-reset.drops-identities` a reset drops an identity linked under another
address; moved to that address and verified in the account's own session (the proof an
automatic link needs is there), the account is still `link-required` for the dropped identity,
until the account holder links it on purpose.

**billing (21)**, the fake provider and its clock: `billing.provider-config` (every deployment)
`GET /billing/config` tells the truth: `none` answers `payments_not_configured` to checkout,
confirmation, promo validation and card setup, serves no fake form or payment webhook, and
leaves memberships `none`; a deployment advertising the fake must serve its form ·
`billing.checkout` refused playback (402
naming `none`), a kids profile cannot start one, the provider's form serves the secret,
confirming before the card is refused, a card whose trial is spent gets none and pays the plan's
price (playback refused while `incomplete`), `complete`, entitled with the plan's streams and
quality, plays, a paid invoice of the plan's price, no second checkout · `billing.challenge` a challenge must be completed; failed, it declines and a new
setup is offered; completed, the membership starts · `billing.declined` declined, insufficient
funds, expired: each `declineReason`, nothing starts, the checkout takes another card ·
`billing.checkout-abandoned` another plan chosen before the first payment leaves membership
`none` / `no_membership` · `billing.checkout-expired` an unconfirmed first payment expires after
23 h on the clock: membership `none` with no plan, provider or period, the checkout expired,
nothing left open (both on the run's spent card: no second trial for a card) ·
`billing.open-checkout` `GET /billing/checkout`: null, then the checkout in progress (plan,
promotion, `promotionOutcome` pending then applied, state, never a client secret, which only
`GET /billing/checkout/:id` gives the continuing session), null once complete ·
`billing.promo-on-trial` a code with a trial: `not_applied_trial`, still named, still valid for
the account, the next bill and the first bill after the trial at the full price ·
`billing.form-leads-back` the fake's form: a way back offered, a decline redirects to
`return?payment=failed`, another card on the same page to `payment=succeeded`, a second
submission too, then the checkout completes · `billing.next-invoice` `membership.nextInvoice`:
the plan's price at the trial's end, at the period's end once active, exactly the preview's
renewal figure and date after a downgrade, null while cancelling, back after resuming ·
`billing.amounts` `GET /billing/checkout` states `trialEligible` with no checkout open (true, then
false once the account had a trial); amounts with their reasons add up as
`amount + creditApplied + discount` = the price before them: the renewal (no reasons), a
downgrade's preview (the new plan's remaining time, the unused time as credit) and its next
renewal, the next invoice using the credit, and a restart's checkout, stated at
`requires_setup` (the account can no longer have a trial) with the credit and the code; the
downgrade's invoice is negative: a credit, nothing paid or due · `billing.promo-budget`
(security review M1) the account's promo-code budget (10 per 10 minutes, both profiles) is spent
by validations and checkouts with a code alike: then both answer 429 with `Retry-After`; the open
checkout's own code answers 201 with the same checkout, a checkout without a code 201; another
account looks codes up as usual · `billing.provider-budget` the checkout start, the card setup and
the previews share the account's `billing` budget (30 per 10 minutes, both profiles, refill
allowed for): spent, a preview and a card setup answer 429 with `Retry-After`; another account
starts a checkout; 50 parallel polls of a card change and of a checkout all answer 200 ·
`billing.promo-code.refused` an unknown code (`unknown`), at validation and checkout ·
`billing.promo-code.applied` the standing `WEBFLIX50` (or `--promo-code`) quoted, the first
payment asks exactly the quoted price and the invoice charges it · `billing.trial-converts` a
labelled card that never had a trial: entitled, nothing charged, then the plan's price charged at
the trial end · `billing.trial-cancelled` (a labelled card that declines whenever charged)
cancelled, resumed, cancelled: entitled until the trial end, then `canceled`, refused playback,
nothing charged or owed, no resume ·
`billing.plan-change` an upgrade invoiced exactly as previewed, a preview of one plan refused for
another, no double charge on replay, a downgrade credits, and the next renewal bills what the
preview said · `billing.member-journey` Google sign-up, a first trial paid when it converts,
watch, cancel, resume, cancel, end, resubscribe with another new card and no second trial (one
per account), watch · `billing.dunning` a failing renewal: `past_due`
with `graceEndsAt`, still playing, an open invoice, the payment-failed email, a failed retry;
`suspended (grace_expired)` after grace, refused playback, no new checkout; a new card pays the
open invoice and playback returns · `billing.provider-events` [x] forged and unsigned events
refused; with every event delivered twice, late and shuffled the membership is the provider's
and each email went once; during an outage the checkout and a card change still complete.

**privacy (11)**: `privacy.events` a batch accepted, read back with the client's ids, times,
payloads and positions, stamped by the server (receipt time, pseudonymous 22-character subject
keys, plan, consent); a client-supplied subject, two devices in a batch, 51 events, over 64 KiB
refused; a signed-out device's own consent; read-back is per account · `privacy.kids-profile` client
events dropped and playback leaving nothing for a kids profile, while the adult profile's are
kept · `privacy.consent` the configured mode (opt-in: withheld until granted, withdrawn again,
`consent.change` per answer; opt-out: collected, Global Privacy Control withdraws, an explicit
grant wins; off: nothing), GPC detected, a kids profile cannot answer · `privacy.export` a fresh
proof, one export at a time (two concurrent requests: exactly one), completed with a link
(emailed), an attachment matching `DataExport` with the account, profiles, events, consents and
each area's part (identity; billing with its `checkouts`, never a client secret, and
`promotionCodes`; personalisation's `recommendationLists` and `personalisationWithdrawnAt`;
admin's `staffAccess`, each item exactly `at` and `action`, staff reading the member included);
the request's `email` pending, then `sent`; another account, a signed-out browser and a tampered
token get nothing; another device of the account without a fresh proof is
`reauthentication_required` in both forms (a bad token is `not_found` first), then downloads with
`POST /privacy/exports/:id/download`, the token in the body; the link lives as long as the terms
say; the email links to the web app's page `{origin}/account/privacy/exports/{id}#token=…` (no
query, the token in the fragment), whose token downloads the document through the POST route. The mode comes from the terms: inline must finish
within twice its typical time; in batch mode the pending entry is checked (the account's key, the retention window up to the
request), then the check waits for the deployment's job as the audit log shows it (a round
within `--export-wait`, then its deferral) · `privacy.export-operator` the operator's export
routes are admin only (four roles refused, a member's session unauthenticated); a results
document for an unknown request is recorded as `ignored` and creates nothing; one naming another
request's file, the member's export document, a lake object, or a complete result without its
checksum is `validation_failed`; in batch mode a `deferred` result keeps the export listed and
`processing`, and so does a `failed` one (the job's next round retries it; a new export is
`privacy_request_pending`; the give-up a day after the request is not observable in a run) ·
`privacy.terms` `GET /privacy/requests` serves the terms (cooling-off, export link lifetime,
export mode and typical time, retention), positive and coherent, the same for another account,
not to a signed-out caller · `privacy.deletion` a fresh proof, one at a time, scheduled after the
terms' cooling-off period (membership effect `none` without a membership), cancellable ·
`privacy.deletion.membership` a paying member's deletion stops the renewals (`ending`, at the
earlier of the period's close and the erasure; no next bill), no renewal is charged when the
period closes inside the cooling-off; keeping the account leaves it `ending` and `resumable`
at the period's close, and resuming renews again · `privacy.deletion.blocks-billing` while the
deletion is scheduled, resume, a plan change, a new checkout and confirming one started before
answer `409 account_deletion_scheduled` (the member cannot make it renew), a preview and a card
change stay allowed, and keeping the account lifts the rule at once · `privacy.deletion.emails`
(privacy review M7) a member's deletion sends `account-deletion-scheduled` with its date and a
link to `/account/privacy`, the request's `email` is `sent`; keeping sends
`account-deletion-canceled`; the renewals it stopped send no `cancellation` email, an ordinary
cancel afterwards does · `privacy.deletion.erasure` the account erased when the period ends
(sessions end, sign-in refused, the address is free); with a staff token: staff read the member
first, and afterwards `GET /system/health` `privacy.erasuresInProgress` returns to 0, `GET
/audit?targetId=<the account>` is empty, and the staff entry remains with target `erased:…` (not
the account id) and `targetLabel` "Erased member". While the erasure runs, a poll that sees
`processing` asserts the account can be neither kept (`not_found`) nor asked again
(`privacy_request_pending`); it usually lasts less than a poll, which the check notes.

**staff (7)**: `staff.roles` seven routes (one per role, and `/me`) for seven personas (each
role, none, another client's admin): allowed exactly for the role and admin, otherwise
`staff_role_required` naming the role; no token, a forged one, an ID token, a member's cookie
are `unauthenticated`; a mutation without the client header is refused; a staff token opens no
member route · `staff.refund` a partial refund, its retry answered with the same refund, the key
with another amount or another staff member `staff_action_conflict`, refunded once on the
invoice (the conflict names the first attempt's audit entry, `auditId`), the rest refunded,
nothing more; both audited with `facts.amount` and the member's address as `targetLabel` ·
`staff.support-audit` reading a member (no password hash), removing a PIN, recording a consent
withdrawal (a staff grant is `consent_grant_member_only` and changes nothing), sending a reset
(the email), signing out everywhere (both devices out): each audited with its request id, reason
and actor · `staff.audit-privacy` (privacy review L9, UX 2.17) a search by a full address leaves a
`member.searched` read whose entry holds no address; a withdrawal is an action labelled with the
member's address and its facts; reading `GET /audit` and the operator's export and erasure lists
writes `audit.read`, `privacy.exports_listed`, `privacy.erasures_listed`; `kind=action` holds no
read and `kind=read` reads only; `GET /system/health` `privacy` has its nine fields, the oldest
given exactly when something waits ·
`staff.console-reads` title search (by name, by ids in order, the unknown left out) and
availability reads for the content role only; `GET /audit/mine` holds the caller's entries
only, `before` null; `GET /audit?requestId=` exactly that request's entries ·
`staff.curated-row` [x] a published collection appears on a member's home page in order and goes
when deleted; both audited · `staff.service-account` the `webflix-jobs` client-credentials grant
gives an access token only, roles exactly admin and experiments, opening the operator routes; a
wrong secret gets no token; a member's session opens no operator route and the job's token no
member route.

**personalisation (1)**: `personalisation.consent` (privacy review L1, pipeline L6) with a
fresh model served (a demo run counts: `node apps/api/src/recs.ts demo`), a member who played a
title gets the model's label (`learned:`/`neighbours:` of the run, `demo:` for a demo run);
personalisation turned off, the page is `rules` with no Top Picks within 30 s and still 35 s
later; turned on, the label is back within 30 s; under a demo run no page (the demo account's
included) says `learned:` or `neighbours:`; the profile made kids gets `rules`. Skips without a
fresh model, and with a trained model that contributes nothing to a new member's page.

**experiments (2)**: `experiments.assignment` [x] two experiments the suite starts (profile and
device units), live at the instant the staff API's answer states (`statusChangeAt`: null in dev,
60 s ahead on Kubernetes and Cloudflare): nobody assigned before it (probed while waiting: an
early assignment means an instance went live early), assigned on the first request after it: a
profile's variant is stable across devices and requests, never given to a kids
profile; a device's is stable and 32 devices spread over both variants; a profile experiment
does not assign anonymous devices; creating and starting are audited ·
`experiments.recommendation-status` admin only (other roles refused); asking for an import says
what it did (`outcome`; only `queued` changes anything); with a run imported, its dates hold, and a new profile's page is labelled `rules` (never `learned:` or `neighbours:`), has
no Top Picks, and has the rows another new profile gets (the billboard rotates per profile by
design).

## Known findings

Product defects the suite found, reported to their owners. The checks stay in place, asserting
what the design calls for; a check marked with a finding (`knownFinding`) reports `XFAIL` while
it fails and `XPASS` once fixed (then remove the mark).

None is open. Fixed, and now asserted as ordinary checks:

| Id | Owner | Finding | Now |
| --- | --- | --- | --- |
| M2-F1 | billing | No promo code could exist on a fake-provider deployment | standing codes, `WEBFLIX_PAYMENTS_FAKE_PROMOTIONS` (`billing.promo-code.applied`) |
| M2-F2 | billing (payments-fake) | Every customer had the same fingerprint per test card: five trials per deployment, ever | labelled cards (`billing.trial-*` pass on every rerun) |
| M2-F3 | billing | An abandoned first payment projected to `canceled` / `ended` | `none` / `no_membership` (`billing.checkout-abandoned`) |
| M2-F4 | billing | `none` after an expired first payment kept `planId`, `provider`, `currentPeriodEnd` | all null (`billing.checkout-expired`) |
| M2-F5 | identity | An unlinked identity relinked itself on its next sign-in | removed identities stay removed, a reset's included (`identity.oidc.unlink-sticks`, `identity.password-reset.drops-identities`) |

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
- **Webhook recovery is mostly invisible from outside.** Every member-facing billing read that
  waits on the provider (a checkout, a card change, the test clock) reads the provider itself, so
  the projection is right without webhooks; what the outage check can prove is that journeys
  complete without them and that nothing is applied twice after. The reconciliation job's own
  repair of a projection nobody polls is covered by the billing area's tests.
- **Not driven here**: the trial-ending email (sent by the scheduled reconciliation inside the
  last 3 days of a trial), the Stripe lane (`tools/stripe`), real Google and Apple, Keycloak,
  extend-trial and complimentary periods, dead-letter replay, experiment exposure events and
  learned serving for a profile the model scored (the imported run must hold that profile).

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
  devices, profiles; `bareSignup` when no membership is needed), `ctx.env.isolatedViewer(tag)`
  for per-profile state (library, playback; `{ member: false }` when the check never plays),
  `ctx.env.browseViewer()` and `ctx.env.catalog()` only for reads, the demo account only for reads.
- Assertions (`src/expect.ts`) carry expected/observed and the request: `succeeds`, `rejects`
  (narrows the problem extensions), `problem`, `status`, `header`, `equal`, `check`, `fail`.
- Anything eventual is polled with `ctx.eventually(what, probe, { timeoutMs })`, never a sleep.
- Anything the target may legitimately lack is a `needs` requirement or a `ctx.skip(reason)`; a
  check that would pass vacuously skips instead.
- A product defect the check found stays asserted: mark the check
  `knownFinding: { id, owner, summary }` (reported `XFAIL` while it fails, `XPASS` once fixed)
  and list it under Known findings.
- Milestone 2 helpers: `src/oidc.ts` (federated sign-in through the development issuer, staff
  tokens), `src/payments.ts` (the fake provider's form, checkout, test clock, delivery policy),
  `src/mail.ts` (the mailbox, link tokens), `src/telemetry.ts` (client events as the SDK builds
  them); `ctx.env.bareSignup`/`bareHolder` (an account without a membership) and
  `ctx.env.issuerSlot()` before each federated sign-in.
- Run `pnpm --filter @webflix/smoke test` (the runner, parsers and HTTP agent have unit tests),
  then the check against a real target.
