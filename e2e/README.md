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
- `E2E_CPU_THROTTLE=4` slows every Chromium page 4x (CDP `Emulation.setCPUThrottlingRate`).
  `make e2e-throttled TARGET=...` is the full Chromium suite at 4x.
- `E2E_STRICT_RATE_LIMITS=1` enables the sign-in lockout spec. It exhausts this address's
  sign-in budget, so run it on its own against an API with strict auth limits
  (`--grep "rate limiting shows"`), never inside a full run.

Browsers: `pnpm --filter @webflix/e2e e2e:install` (part of `make setup`) installs Chromium,
Firefox and WebKit for the pinned Playwright.

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
(:4000). `SMOKE_ARGS` is passed through.

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

**Content-Security-Policy violations fail the spec.** Every browser context watches the
console, and a CSP violation (a blocked script, style, image, media or connection) fails the
spec that caused it, with the blocked URL and the directive. A blocked resource is a broken page
wherever the deployment serves a CSP.

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
| Firefox | `cross-browser.spec.ts` | hls.js over MediaSource | Landing, sign-in, browse, overlay, playback with real decoded frames. Firefox has no native HLS, so that spec skips with the reason. |
| WebKit | `cross-browser.spec.ts` | hls.js over MediaSource; native HLS when MediaSource is withheld | Native HLS is what Safari on iPhone uses: the spec removes MediaSource before the app starts, and the player plays the playlist natively (H.264/AAC fMP4 decodes in Playwright's WebKit on macOS). |

What this cannot verify: real Safari and iOS. Playwright's WebKit is not Safari, and has no iOS
fullscreen, autoplay or ManagedMediaSource-only behaviour. Hardware-decoded output and
DRM are also out of reach (DRM is out of scope). Desktop Safari has MediaSource, so it takes the
hls.js path like the other desktop engines.

## Writing a spec

- Import `test` and `expect` from `./fixtures.ts`, and account and catalogue helpers from
  `./api.ts`.
- Read-only on the demo account: `test.use({ demo: "Alex" })`. Anything that changes data:
  `createAccount(page.context().request, { tag })`.
- Never hard-code a title id, an asset, a duration or which title has a clip.
- Assert on the destination screen, not on the URL alone. The URL changes as navigation starts,
  while the previous screen (and its fields) is still on screen.
- Run it a few times in parallel before you commit
  (`--repeat-each 5 --workers 8`), and once with `E2E_CPU_THROTTLE=4`.

Output: `test-results/` (traces, videos and screenshots of failures) and `playwright-report/`.
