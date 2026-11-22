# @webflix/e2e: browser suites

Two Playwright suites:

| Suite | Config | Runs against | Command |
| --- | --- | --- | --- |
| `tests/` | `playwright.config.ts` | any running mode (`BASE_URL`) with a real API | `make e2e TARGET=dev\|k8s\|cf` |
| `mock/` | `playwright.mock.config.ts` | the web app in mock mode (no backend), started for you | `make e2e-mock` |

This file is about `tests/`, the suite that gates deployments.

## Running it

Start a mode, then point the suite at the origin people load:

| Mode | Start | Run |
| --- | --- | --- |
| dev | `make dev` (web :5173, API :4000) | `make e2e TARGET=dev` |
| Cloudflare | `make cf-dev` (:8787) | `make e2e TARGET=cf` |
| Kubernetes | `make k8s-up RATE_LIMITS=relaxed` (:8080) | `make e2e TARGET=k8s` |
| anything else | | `make e2e BASE_URL=http://localhost:5012` |

Options (environment):

- `E2E_BROWSERS=chromium` limits the browsers (default `chromium,firefox,webkit`).
- `E2E_WORKERS=2` sets the number of workers (default 4; see [Host guard](#host-guard)).
- `E2E_VIDEO=1` keeps a video of each failing test. Off by default: use it while a failure is
  being investigated, not for gate runs.
- `E2E_CPU_THROTTLE=4` slows every Chromium page 4x (CDP `Emulation.setCPUThrottlingRate`).
  `make e2e-throttled TARGET=...` is the full Chromium suite at 4x.
- `E2E_STRICT_RATE_LIMITS=1` enables the sign-in lockout spec. It exhausts this address's
  sign-in budget, so run it on its own against an API with strict auth limits
  (`--grep "rate limiting shows"`), never inside a full run.

Browsers: `pnpm --filter @webflix/e2e e2e:install` (part of `make setup`) installs Chromium,
Firefox and WebKit for the pinned Playwright.

### Host guard

On 2026-11-22 a full run on the owner's Mac (48 GB, 18 cores) ran the host out of memory: Playwright
at its default nine workers recorded a video and a trace of every test, next to the Docker VM, the
Cloudflare runtime and other work, on a host already 27 GB into swap. The window server aborted and
the owner's session ended with every app in it. Two things now keep a run from doing that:

**Limits in the configs** (`host-limits.ts`, both suites): 4 workers unless `E2E_WORKERS` says
otherwise, no video unless `E2E_VIDEO=1`, and traces only kept for failures
(`retain-on-failure`). WebKit's traces take no screenshots, so WebKit does no continuous capture of
its window; a failing WebKit test still gets its one screenshot.

**`scripts/host-guard.sh <command...>`** runs a command and stops it, with every process it started,
when the host runs short. `make e2e`, `make e2e-throttled`, `make verify`, `make e2e-mock` and
`make screenshots` run through it; prefix anything else heavy with it (a direct
`pnpm exec playwright test`, a redeploy, a reproduction loop).

| Limit | Default | Variable |
| --- | --- | --- |
| Swap in use | 6000 MB | `HOST_GUARD_SWAP_MAX_MB` |
| 1-minute load average | 45 | `HOST_GUARD_LOAD_MAX` |
| Kernel graphics surfaces (`ioclasscount IOSurface`, about 190 idle) | 3000 | `HOST_GUARD_SURFACES_MAX` |

- It samples every `HOST_GUARD_INTERVAL_SEC` (5) seconds. `HOST_GUARD_STRIKES` (3) samples in a row
  over any limit (15 s) stop the command: SIGTERM to its whole process tree, then SIGKILL after
  `HOST_GUARD_GRACE_SEC` (10) s. A host already over a limit does not get the command started.
- **Exit code 99 means the guard stopped the command, or would not start it.** The reason is on
  stderr. It is not a test result: stop, look at what is using the machine, and do not start
  another run to see whether it happens again. Any other exit code is the command's own.
- `HOST_GUARD_LOG=<file>` appends one line per sample (swap, load, surfaces and the compressor's
  size); `scripts/host-guard.sh --probe` prints one sample. At the end the guard prints the peak
  swap, the peak load and the surface count before and after.
- `HOST_GUARD=off` runs the command unguarded. Where the probes do not exist (Linux, most CI) the
  guard is a no-op.
- Ctrl-C reaches the command directly; SIGTERM to the guard is passed to the whole tree.
- `pnpm test` (`scripts/check-host-guard.ts`) proves it with a fake probe: it refuses to start
  over each limit, stops a running command and its detached and SIGTERM-ignoring children, honours
  the variables, reads real values on a Mac, and sits in front of each make target above.

**WebKit does not run while the screen is locked.** On a locked Mac, Playwright's WebKit loses
pointer input (below), and it is the suspect for the kernel memory growth of that night (unproven).
A run that includes WebKit refuses to start when `ioreg` reports `CGSSessionScreenIsLocked`; run
`E2E_BROWSERS=chromium,firefox` and report WebKit as not run. Check before each run, and again
after: a screen that locks mid-run voids that run's WebKit results. Never wake the display, unlock,
or keep the machine awake for a run.

### Verify: the browser suite, then the conformance suite

```sh
make verify TARGET=dev|k8s|cf
make verify BASE_URL=http://localhost:5012 SMOKE_BASE_URL=http://localhost:5011
```

`scripts/verify.ts` runs the browser suite, waits one rate-limit window, runs the conformance
suite (`tools/smoke`), and prints one summary. It exits non-zero if either suite has a failure,
or the browser suite has a flaky test. Reports: `test-results/verify/e2e.json` and
`test-results/verify/conformance.json`.

Why this order. The conformance suite ends by deliberately exhausting the sign-in, sign-up and
email-lookup budgets of the address it runs from. Run before the browser suite, it leaves that
suite throttled. Before this suite waited out `429`s, that showed up as 25 `sign in: 429`
failures. So the browser suite runs first. Then `verify` waits `VERIFY_COOLDOWN_SEC` (default 65 s,
one window plus a margin), so the conformance suite starts with the full budgets it would have on
its own, and its rate-limit checks measure the deployment, not what the browser suite just spent.
The two suites never run at the same time.

`SMOKE_BASE_URL` defaults to `BASE_URL`, except `TARGET=dev`, where the API has its own origin
(:4000). `SMOKE_ARGS` is passed through. `make verify … VERIFY_DRY_RUN=1` prints the two origins
and runs nothing. `scripts/check-verify-urls.ts` (the package's `pnpm test`) asserts them for
every target under bash and zsh. Make resolves the origins: in one shell command, bash expands a
later prefix assignment with an earlier one (except when the line is a lone command), so a recipe
that let the shell resolve them sent the dev conformance suite to the web port.

## Isolation model

Every spec can run in parallel with every other spec, in any order, right after anything else
(including the conformance suite), on any mode and under strict or relaxed rate limits.

**The seeded demo account is shared and read-only.** `test.use({ demo: "Alex" })` (also `"Mia"`,
`"Kids"`) starts the page signed in to `demo@webflix.dev` with that profile active. The `setup`
project (`tests/demo.setup.ts`) signs in once per profile per run and stores the session in
`e2e/.auth/<origin>/` (git-ignored). Every spec reuses it. A run therefore spends three sign-ins
and three profile selections on the demo account, not one per test: with one per test, the run
hit the sign-in limit (60/min per address, relaxed) and the per-account profile-selection limit.

Because those sessions are shared, a spec on them must not change anything. The fixture records
every mutating API call (`POST`/`PUT`/`PATCH`/`DELETE` under `/api/`) from the browser, and the
spec fails with the call named. Examples: adding to My List, rating, switching profile, signing
out, starting playback. The check observes requests rather than intercepting them, because
interception would route every image through Playwright and switch off the HTTP cache.

**Everything that changes data uses a fresh account** (`createAccount` in `tests/api.ts`). That
covers My List, ratings, profile settings, plans, devices, playback and stream slots, Continue
Watching, and sign-out. A fresh account has nothing another spec can touch, so nothing needs
putting back and nothing needs to run serially. Second devices are `newDevice()` contexts
(throttled like the page and closed after the test).

`createAccount` is HTTP only and makes a member the only way there is (no card ever reaches
Webflix): it signs up (`{email, password}`), checks out at the fake payment provider
(`becomeMember`: `POST /billing/checkout`, the card confirmed at `/_pay/api/confirm` with a
labelled test card of its own, `POST /billing/checkout/:id/confirm`), moves the account's test
clock past the trial so the membership is active and paid, then creates and selects the profile.
It takes about as long as milestone 1's sign-up with a card did (password hashing dominates:
median 146 ms against 135 ms for sign-up, profile and selection alone, measured on a dev API). It
needs the fake provider: against a deployment without it (production configuration) the specs that
need a member cannot run. `signUp` alone gives an account without a membership.

**Content-Security-Policy violations fail the spec.** Every browser context watches the
console, and a CSP violation (a blocked script, style, image, media or connection) fails the
spec that caused it, with the blocked URL and the directive. A blocked resource is a broken page
wherever the deployment serves a CSP. The same watch fails a spec when React reports a state update
during another component's render ("Cannot update a component ... while rendering a different
component"), which only development builds report (the dev mode).

**Rate limits are waited out, never failed on.** `sendPatiently` (used by sign-up, sign-in and
profile selection) waits for `Retry-After` on a `429` and extends the test's timeout by that wait.
Under strict limits (Kubernetes by default: 5 sign-ups and 10 sign-ins per minute per address)
the suite is slower, not red.

**Content is discovered, not hard-coded.** The content pipeline changes which titles have media,
how long they are and which have preview clips. Specs pick titles through the API instead.
`catalogCards` lists what the profile can see. `findPlayableTitle` finds a movie or a series
whose stream is packaged on this target, by starting and stopping playback the way the
conformance suite does. A spec that cannot be meaningful on a target skips with the reason, for
example when the billboard has no preview clip to withhold.

Couplings this removed, for the record: library specs edited the demo profile Mia (serial, and
"put back" on success only); profile-switch and session-ending specs changed the session they
browsed with; the maturity spec played on the demo Kids profile with a hard-coded title; every
browse spec signed in to the demo account per test.

## Flake policy

- **No retries locally; a flaky test fails the run everywhere** (`failOnFlakyTests`). CI retries
  once, only so a trace of the first failure exists.
- **The gate**: three consecutive full runs with zero failures and zero flaky on each mode, plus
  one run at `E2E_CPU_THROTTLE=4`.
- **No sleeps standing in for state.** Wait for the state itself: a retrying assertion, a
  response (`waitForResponse` before reading the server after an optimistic UI), animations
  finished (`waitForAnimations`) before measuring geometry or contrast, or a record kept in the
  page (`MutationObserver`) when an assertion depends on timing. A fixed wait is right only when
  the product's own timing is the subject. Examples: the 500 ms after a scroll in which no preview
  may open, or proving that nothing happens.
- **Budgets.** Assertions get 10 s, because a screen's first content follows a navigation, a
  session bootstrap and its data. On this shared machine, with another project's VM holding ten
  cores, API answers took 3 to 5 s. Under `E2E_CPU_THROTTLE` the assertion and test budgets scale
  by the factor. What a throttled run proves (hover intent, sweep dwell, glide and preview timing)
  is measured against product timers, not budgets.
- **Never lengthen a timeout or add a retry to make a failure go away** unless the trace shows the
  product behaving correctly and the wait is inherent. A failure is a product defect, a test
  defect or the environment until shown otherwise. Fix it where the fault is.

## What each browser engine covers

| Engine | Specs | Playback path | Notes |
| --- | --- | --- | --- |
| Chromium | everything | hls.js over MediaSource; native HLS when MediaSource is withheld | The full suite, the throttled run, axe. |
| Firefox | `*cross-browser.spec.ts`, `ops-docs.spec.ts` | hls.js over MediaSource | Landing, sign-in, browse, overlay, playback with real decoded frames (`cross-browser.spec.ts`); the landing teaser, sign-up's profile step, the profile editor's Save bar and toasts (`member-cross-browser.spec.ts`); the signed-out overlay and the post-play screen (`watch-cross-browser.spec.ts`). Firefox has no native HLS, so that spec skips with the reason. |
| WebKit | `*cross-browser.spec.ts`, `ops-docs.spec.ts` | hls.js over MediaSource; native HLS when MediaSource is withheld | Native HLS is what Safari on iPhone uses: the spec removes MediaSource before the app starts, and the player plays the playlist natively (H.264/AAC fMP4 decodes in Playwright's WebKit on macOS). |

`ops-docs.spec.ts` (the API reference renders under its Content-Security-Policy, with no
violation) runs in every engine, because engines enforce policies differently.

**Host condition: Playwright's WebKit needs an unlocked, awake display on macOS.** While the
Mac's screen is locked and its display asleep, WebKit discards the coordinates of every
synthesized mouse event: all of them land on one constant point outside the page, no
`pointermove` fires, and clicks fail with "`<html>` intercepts pointer events". Taps, keyboard
and URL-driven specs are unaffected, and so are Chromium and Firefox. A product-independent
repro is in the QA notes (a blank page; moves to three points arrive at one). Run WebKit only
with the owner's session unlocked (the config refuses otherwise, see
[Host guard](#host-guard)), and report it as not run, not as passed, when it is locked.

What this cannot verify: real Safari and iOS. Playwright's WebKit is not Safari, and has no iOS
fullscreen, autoplay or ManagedMediaSource-only behaviour. Hardware-decoded output and
DRM are also out of reach (DRM is out of scope). Desktop Safari has MediaSource, so it takes the
hls.js path like the other desktop engines.

## Writing a spec

- Import `test` and `expect` from `./fixtures.ts`, and account and catalogue helpers from
  `./api.ts`.
- Read-only on the demo account: `test.use({ demo: "Alex" })`. Anything that changes data:
  `createAccount(page.context().request, { tag })` (a paying member; `signUp` for an account
  without one).
- Never hard-code a title id, an asset, a duration or which title has a clip.
- Assert on the destination screen, not on the URL alone. The URL changes as navigation starts,
  while the previous screen (and its fields) is still on screen.
- Run it a few times in parallel before you commit, through the guard and with at most 4 workers
  (`scripts/host-guard.sh pnpm exec playwright test <spec> --repeat-each 5`), and once with
  `E2E_CPU_THROTTLE=4`.

Output: `test-results/` (traces and screenshots of failures; videos with `E2E_VIDEO=1`) and
`playwright-report/`.
