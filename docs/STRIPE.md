# Stripe: what was verified, and how

Written for the author of `packages/adapters-stripe` and for whoever runs the Stripe lane of the
gate. It records what was **observed** against a real Stripe sandbox from this machine on
2026-11-21/22 (UTC), and how. Statements taken from Stripe's documentation rather than observed
are marked **(docs)**, with the page. Statements neither observed nor documented are marked
**not verified**. Blueprint references (§) are to `docs/BLUEPRINT-M2.md` unless another document
is named.

```sh
make stripe-sandbox      # create or reuse the sandbox (idempotent; prints no key)
make stripe-status       # sandbox, expiry, claim state, listeners, isolation checks
make stripe-listen       # stripe listen → the dev API (MODE=dev|k8s|cf, or FORWARD_TO=url)
make stripe-proof        # the proof run (about 5 minutes); regenerates tools/stripe/fixtures
make stripe-reset        # forget the local credentials (nothing is deleted on Stripe)
make stripe-claim        # owner only: open Stripe's claim page for this sandbox
make stripe-use-key      # owner only: use your own test keys (a claimed sandbox's full key)
```

**Contents.** 1 Outcome · 2 The background claims, checked · 3 Provisioning and the
repository-local CLI profile · 4 What the sandbox key may do · 5 The tooling · 6 The proof run ·
7 Recommended API shapes · 8 What each scenario showed · 9 Mapping Stripe states to §5.2 ·
10 Events: act on, ignore · 11 Ordering, duplicates, failures, outages · 12 Time: test clocks and
the real-time substitute · 13 Rate limits and costs · 14 API version and stripe-node · 15 What the
browser needs · 16 Sandbox lifecycle · 17 Where §5 is wrong or incomplete · 18 Not verified ·
19 Fixtures · Appendix: event sequences.

---

## 1. Outcome

- **Anonymous provisioning works from this machine.** With no Stripe login, `make stripe-sandbox`
  ran `stripe sandboxes create --email webflix-sandbox@example.com --non-interactive` with the
  pinned CLI (1.55.14). In about 2 seconds it received a sandbox account, a publishable key, a
  **restricted** secret key (`rkcs_test_…`), a claim link and an expiry date 7 days ahead. It
  needed no browser, no account and no prompt. Exactly one sandbox was created (2026-11-21
  17:57:50 UTC), and the CLI reports its expiry as 2026-11-28. It has not been claimed.
- **The sandbox key cannot create test clocks.** `POST /v1/test_helpers/test_clocks` answers 403:
  "This is a claimable sandbox key with limited permissions. Use the claim URL provided when the
  sandbox was created to get a full API key." So §5.5's plan to drive renewals, failures and
  recovery with test clocks in an unclaimed sandbox **does not work** (§17).
- **Everything else the billing design needs is permitted** (§4). The proof therefore runs in
  **real time**. Trials last 40 seconds, so a real `subscription_cycle` renewal invoice appears
  12–47 s after the trial ends; the test finalises it and calls `invoices.pay`, an off-session
  attempt equivalent to Stripe's own. The checks that need days of simulated time are recorded
  as **skipped**, never as passed. Given a full test key, the same command switches to test
  clocks automatically.
- **Final proof run:** 11 scenarios passed, with 6 clock-only checks skipped. It took 290 s and
  147 API calls, and received 323 signed webhook deliveries, every one verified with Web Crypto.
  Its scrubbed record is in `tools/stripe/fixtures` (34 files, 1.9 MB).
- **Isolation holds.** No file was created or modified under `~/.config/stripe` or `~/.stripe`
  (neither exists), and the macOS keychain holds no `StripeCLI` item, before or after.

## 2. The background claims, checked

| Claim | Verdict | Evidence |
| --- | --- | --- |
| With the CLI not logged in, `stripe sandbox create` provisions a sandbox with working test keys and no account | **Confirmed, with corrections.** The command is `stripe sandboxes create` (`sandbox` is an alias) and **requires `--email` or `--from-git`**. The secret key is a *restricted claimable-sandbox key* with limited permissions (§4). Provisioning solves a proof-of-work challenge from `ai.stripe.com`. If provisioning fails, the CLI falls back to a browser login (with `--non-interactive`, it prints a login URL instead). | Observed run (§3); CLI 1.55.14 source `pkg/cmd/sandbox.go`, `pkg/sandbox/sandbox.go`. Docs disagree on the name: docs.stripe.com/cli/sandbox says `stripe sandbox create --email …`, docs.stripe.com/sandboxes/claimable-sandboxes says `stripe sandboxes create` **(docs)** |
| The credentials are saved to the CLI profile | **Confirmed.** In plain text in the profile's `config.toml` (`test_mode_api_key`, `test_mode_pub_key`, `sandbox_claim_url`, `sandbox_expires_at`, `account_id`), file mode 0600, not in the keychain. The CLI also prints the secret key and claim link to stdout. | Observed (key names only were inspected); source `saveSandboxToConfig` |
| It expires after 7 days unless claimed with `stripe sandbox claim` | **Consistent with what was observed, expiry itself not observed.** The CLI recorded an expiry date 7 days after creation. It stores the date only and treats the sandbox as expired from 00:00 UTC that day. The claim-status endpoint returns only `is_claimed` (false). The claim link is `https://dashboard.stripe.com/onboard_sandbox/<token>`, a capability URL. What happens at expiry is **not verified** (it falls after this work). | Observed; docs: "Sandbox environments expire after 7 days. Claim your sandbox before it expires by running `stripe sandbox claim` to keep your account and data." (docs.stripe.com/cli/sandbox) **(docs)**. The Claimable Sandboxes *API* for platforms gives 60 days; that is a different product **(docs)** |
| Stripe's sandbox documentation suggests `npm i -g @stripe/cli` | **Partly.** docs.stripe.com/sandboxes says to install the CLI "using the installation script for your operating system". The npm route (`npm i -g @stripe/cli@latest`) is on docs.stripe.com/cli/install, which also notes "Package manager installations don't support automatic updates." | **(docs)**. Here the npm package is a pinned dev dependency of `tools/stripe` (`@stripe/cli` 1.55.14, exact), never global. Its binary comes from the per-platform optional package (`@stripe/cli-darwin-arm64`, published with npm provenance), and its sha512 is in `pnpm-lock.yaml`. pnpm skips the package's postinstall (a GitHub download fallback); it is not needed. |
| Test clocks: at most three customers per clock, forward only | **Not observable with this key** (403). **(docs)**: "Three customers; Three subscriptions, including scheduled subscriptions, per customer"; an advance may go at most "two intervals in the future from the shortest subscription"; status `advancing`, `ready` or `internal_failure`. Docs disagree about cleanup: "deleted 30 days after you create them" versus a 7-day `deletes_after` in the API example. | docs.stripe.com/billing/testing/test-clocks/api-advanced-usage, /api/test_clocks **(docs)** |

## 3. Provisioning and the repository-local CLI profile

**What `--config` does not cover.** The obvious flag is not enough. In CLI 1.55.14, `--config`
("config file (default is $HOME/.config/stripe/config.toml)") moves `config.toml` and nothing
else. The keyring fallback file (`credentials.json`), plugins, pending-login state and the docs
cache all follow `XDG_CONFIG_HOME`. Docs: "If you set an XDG_CONFIG_HOME environment variable,
the directory is $XDG_CONFIG_HOME/stripe" **(docs)**. In addition, the update check writes
`~/.stripe/state/latest_release.json` (and calls GitHub) whatever the config location is.
Source: `pkg/config/config.go`, `pkg/version/version.go`, `pkg/autoupdate/config.go`, read
from the Go module proxy copy of v1.55.14.

**The environment every CLI run gets** (`tools/stripe/src/stripe-cli.ts`, `isolatedEnv`):

| Setting | Why |
| --- | --- |
| `XDG_CONFIG_HOME=.cache/stripe/config` and `--config .cache/stripe/config/stripe/config.toml` | the documented way to relocate the whole configuration directory |
| `--project-name webflix` | keyring items are keyed `uat:<profile>`, except for the `default` profile, whose bare `uat` key is what a global `stripe login` uses. A non-default name can never read or remove the owner's login. |
| `HOME=.cache/stripe/home` | defence in depth for undocumented home-directory writes (this directory stayed empty) |
| `STRIPE_NO_UPDATE_CHECK=1`, `STRIPE_NO_AUTO_UPDATE=1`, `STRIPE_CLI_NO_PLUGIN_AUTO_INSTALL=1` | no `~/.stripe/state`, no GitHub calls, no self-modification. Only `STRIPE_NO_AUTO_UPDATE` is documented. |
| `STRIPE_CLI_TELEMETRY_OPTOUT=1` | no telemetry or crash reports **(docs)** |
| nothing else inherited (except `PATH`, `TERM`, proxy variables) | an exported `STRIPE_API_KEY` or `XDG_CONFIG_HOME` in the caller's shell cannot redirect the CLI |

**How isolation was proven.**

- **Baseline, before the CLI first ran:** `~/.config/stripe` and `~/.stripe` absent, no Stripe
  directory in `~/Library/Application Support`, and
  `security find-generic-password -s StripeCLI` exiting 44 (no item; exit code only, never
  contents).
- **Every run is checked:** `runCli` takes a stat snapshot of the global locations before and
  after each CLI invocation and fails loudly on any change. `stripe listen` sidecars are checked
  at stop.
- **After all the work:** both locations are still absent and the keychain check still exits 44
  (§19 lists the commands). The CLI's own writes all landed in `.cache/stripe/config/stripe/`:
  `config.toml` and a `docs/cache` directory. Even `stripe version` writes the former, recording
  a machine UUID and the project name.

**The email.** `--email` "is used to prefill the account registration form when you claim the
sandbox" (CLI help). The tooling sends the reserved placeholder `webflix-sandbox@example.com`
unless `STRIPE_SANDBOX_EMAIL` is set, so no real person is enrolled or emailed. Stripe accepted
the placeholder.

## 4. What the sandbox key may do

Every call below was made with the claimable sandbox key. Each row is the HTTP status observed.

| Allowed (200, or a business error such as 402) | Refused (403 "claimable sandbox key with limited permissions") |
| --- | --- |
| customers (create, update, list), `payment_methods/{id}/attach`, setup_intents, payment_intents | **`POST /v1/test_helpers/test_clocks`** (listing them is allowed) |
| products (custom ids), prices (lookup keys, `transfer_lookup_key`), coupons, promotion_codes | **`POST /v1/customer_sessions`** (the Payment Element's saved-payment-method feature) |
| subscriptions (create, update, cancel), subscription_schedules, `invoices/create_preview`, `invoices/{id}/finalize`, `invoices/{id}/pay`, invoice_payments | `POST /v1/billing/meters`, `POST /v1/tax/calculations`, `GET /v1/tax/settings` |
| refunds, customer balance transactions, billing_portal sessions | `GET /v1/balance`, `GET /v1/radar/value_lists` |
| webhook_endpoints (create, delete), events (list), `events/{id}/retry` (`stripe events resend`) | |
| `GET /v1/account` (the account's default API version is `2026-11-18.endive`) | |
| `stripe listen` (the CLI session is created with this key) | |

The account behind the key is a plain US test account. Its subscriptions use `billing_mode:
flexible` (observed on every subscription), which is the default since 2025-09-30.clover
**(docs)**.

## 5. The tooling (`tools/stripe`)

| Command | What it does |
| --- | --- |
| `make stripe-sandbox` | Checks that the pinned CLI binary reports its pinned version. If a sandbox is configured, it probes it (`GET /v1/customers?limit=1`; 401 means gone) and asks Stripe whether it is claimed (`GET /v2/core/claimable_sandboxes/status`, the endpoint and preview version the CLI itself uses). It **reuses** a sandbox that works and has more than `STRIPE_SANDBOX_MIN_HOURS` (default 24) left, and otherwise creates one. It never replaces a sandbox because the network is down. It adopts a sandbox the CLI profile already holds, and retries once if the CLI reports the profile's sandbox expired (it clears it itself); these two paths are unit-tested, not exercised. It prints the account, the key *kind*, the expiry and claim instructions, never a key. Exit codes: 0 when done, 1 with a reason otherwise. |
| `make stripe-status` | CLI version, profile, sandbox, live credential check, expiry, claim state, whether the webhook secret is captured, sidecars, history of sandboxes created from this checkout, the global Stripe locations and the keychain check. |
| `make stripe-listen` | `MODE=dev` (default) forwards to `http://localhost:4000/api/v1/webhooks/payments/stripe`; `k8s` and `cf` use ports 8080 and 8787; `FORWARD_TO=url` overrides. `NAME` names the sidecar (default: the mode), `EVENTS=a,b` limits the events (default `--all-snapshot`; §11), and `LATEST=1` adds `--latest`. It first runs `stripe listen --print-secret` and stores the signing secret, warning if it **changed**. It then starts a detached `stripe listen` with its own process group, output to a 0600 log (the CLI prints the secret there) and a PID record. It waits for the "Ready!" line and records the API version events are rendered in. A second start with the same URL reports "already running"; with a different URL it refuses. A stale record is removed. |
| `make stripe-listen-stop` | Stops by **PID** after checking that the PID's command line is this repository's CLI binary running `listen` (a reused PID is never killed): SIGTERM, then SIGKILL after 10 s. `ALL=1` stops every sidecar. |
| `make stripe-listen-logs` | Prints the redacted tail of a sidecar log. |
| `make stripe-proof` | The proof run (§6). `PROOF_ARGS="--only a,b --time auto\|clock\|real --keep-clocks --no-fixtures --port 5510 --concurrency 4"`. |
| `make stripe-reset` | Stops sidecars and deletes the state files, the CLI profile directory, the raw run records and the sidecar logs. It then says what remains on Stripe: the sandbox and everything in it stay until expiry or a claim, and only a logged-in account can delete a sandbox (`stripe sandboxes delete`), which the tooling never uses. Exercised: `.cache/stripe` was backed up, reset, and restored. |
| `make stripe-claim` | For the owner only. Runs `stripe sandboxes claim` interactively with the repository profile, which opens Stripe's claim page. **Not run in this work.** |
| `make stripe-use-key` | For the owner only. Reads test keys from a hidden prompt or from `FROM=<file>` (`STRIPE_SECRET_KEY=` and `STRIPE_PUBLISHABLE_KEY=` lines; keep that file under `.cache/stripe`), never from argv. It refuses live keys, checks the key with `GET /v1/account` and records it. Sidecars then receive it as `STRIPE_API_KEY` in their environment, because the CLI profile does not hold it. Exercised with a file holding the current sandbox's keys; the sidecar's command line carried no key. |

**Files** (all under `.cache/stripe`, which the root `.gitignore` rule `.cache/` already covers;
directories 0700, files 0600, written through a 0600 temporary file and renamed):

| File | Contents |
| --- | --- |
| `sandbox.json` | account, keys, claim link, expiry, webhook signing secret |
| `stripe.env` | the same as `STRIPE_ACCOUNT_ID`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SANDBOX_EXPIRES_ON` (no claim link), for other modes' tooling |
| `config/stripe/config.toml` | the CLI's own profile |
| `listen/<name>.{json,log}` | sidecar records and logs |
| `runs/<id>/raw.json` | unscrubbed proof records (they contain client secrets) |
| `history.jsonl` | non-secret history: account ids and dates |

**Output hygiene.** Every line the tooling prints passes through `redact()`. It covers API keys
of any `<prefix>_test_`/`_live_` shape, Stripe's masked key form (which permission errors
contain: prefix, asterisks, last four), `whsec_` secrets, client secrets, CLI OAuth tokens and
claim links. The claim link does **not** contain the word "claim", so a naive filter would have
missed it.

**Tests** (`pnpm --filter @webflix/stripe test`, 57 tests) cover the redactor, the scrubber, the
create-output parser and reuse decision, listener output parsing, CLI environment isolation, the
state files, event attribution and key import. **`test/secret-scan.test.ts`** fails if any
Stripe credential or claim link appears in a tracked or untracked, non-ignored file of the
repository (`git ls-files --cached --others --exclude-standard`, binaries and files over 8 MiB
skipped). It also checks that the credential paths are ignored. Its own fake secrets are
assembled at run time, so no source file contains one.

## 6. The proof run

`make stripe-proof` runs `node --conditions=worker tools/stripe/proof/run.ts`. The `worker`
export condition makes `import Stripe from "stripe"` load stripe-node's **Workers build**
(`stripe.esm.worker.js`). That build uses `fetch` for HTTP and Web Crypto for signatures, and
its Node HTTP client and Node crypto provider throw if called. The client is also given
`Stripe.createFetchHttpClient(countingFetch)` explicitly, and webhooks are verified with
`stripe.webhooks.constructEventAsync(raw, header, secret, 300, Stripe.createSubtleCryptoProvider())`.
So the calls the adapter will make are exercised on the code path Workers will run.

1. **Time mode.** It tries to create, then delete, a test clock. A 403 means real time (§12);
   `--time` forces either mode.
2. **Webhooks.**
   - A receiver on `127.0.0.1:5510` (the range 5500–5549 is allowed) verifies each delivery over
     the raw body, records it in arrival order with a timestamp, and answers 200 (or a chosen
     status, to test failures).
   - A managed `stripe listen --all-snapshot` sidecar forwards to it.
   - Events are assigned to scenarios through the ids their objects refer to (customer, clock,
     subscription, invoice, payment, product, coupon). Ownership spreads to dependent objects;
     line-item prices are ignored, so the shared catalogue does not claim subscription events.
3. **Scenarios.**
   - The catalogue runs first.
   - Nine scenarios run four at a time. Each creates its own customers, and its own clock in
     clock mode.
   - The delivery-anomalies scenario runs last and alone, because it stops and restarts the
     listener.
4. **The browser's part.** Confirmations use only the **publishable key and the intent's client
   secret**, never the secret key, against `/v1/{setup,payment}_intents/{id}/confirm`, with
   Stripe's test PaymentMethod ids (`pm_card_visa`, `pm_card_chargeCustomerFail` (…0341),
   `pm_card_authenticationRequired` (…3184), `pm_card_mastercard`, `pm_card_visa_chargeDeclined`).
   Raw card numbers cannot be used this way: Stripe answers `unsupported_publishable_key_tokenization_surface`
   ("This integration surface is unsupported for publishable key tokenization"). Only Stripe.js
   may send card data with a publishable key.
5. **Record and clean-up.**
   - The raw record goes to `.cache/stripe/runs/<id>/raw.json`.
   - The scrubbed fixtures replace `tools/stripe/fixtures` (§19).
   - Test clocks are deleted, and subscriptions the run left running are canceled, so the sandbox
     stays quiet.
   - The exit status is 1 if any scenario failed or any expectation was not met.

Regenerate fixtures without calling Stripe (after a scrubber change, say):
`node tools/stripe/proof/refixture.ts [.cache/stripe/runs/<id>/raw.json]`. Two regenerations from
one record were byte-identical. Print the event tables in the appendix with
`node tools/stripe/proof/report.ts [scenario…]`.

**From a fresh sandbox, one command:** `make stripe-proof` after `make stripe-sandbox`. The first
run against this sandbox created the catalogue: 3 products and 6 prices, at 18:11:47–50 UTC,
with idempotency keys `webflix-catalogue-…`, as Stripe's events show. Every later run created
no plan price. That first run then stopped on an unrelated defect in the recorder (§14, the
`Decimal` hazard), so the committed fixtures come from a later run, in which the catalogue
already existed.

## 7. Recommended API shapes

**Sign-up with a trial (blueprint §5.1, §5.4).** On the server:
`customers.create`, then `subscriptions.create({ customer, items: [{ price }], trial_period_days: 7,
payment_behavior: "default_incomplete", payment_settings: { save_default_payment_method:
"on_subscription" }, trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
expand: ["pending_setup_intent", "latest_invoice.confirmation_secret"] })`. The browser confirms
`pending_setup_intent.client_secret` with the Payment Element (`stripe.confirmSetup`).

Observed:

- Status `trialing`, with a paid zero-total `subscription_create` invoice.
- `setup_intent.succeeded` about 1 s after confirmation.
- The subscription's `default_payment_method` is set *asynchronously*, by a
  `customer.subscription.updated` 0.3–2 s later. Read it from the SetupIntent if needed sooner.

**Sign-up without a trial, resubscribe.** The same call without the trial fields. The browser
confirms `latest_invoice.confirmation_secret.client_secret` with `stripe.confirmPayment`.

- `invoice.payment_intent` no longer exists. The confirmation secret is the way in since
  2025-03-31.basil **(docs)**, and its `type` is `payment_intent`.
- Observed: `incomplete` until confirmed, then `active`.
- A card that needs a challenge gives `requires_action` with a `redirect_to_url` next action on
  `hooks.stripe.com`.

**Which shape for the on-site form: the deferred-intent flow (recommended).**
`elements({ mode: "subscription", amount, currency })`, then `elements.submit()`, then the
server creates the subscription (exactly as above), then `confirmSetup` or `confirmPayment` with
the secret the server returns. Stripe documents this for subscriptions **(docs)**
(docs.stripe.com/payments/accept-a-payment-deferred?type=subscription).

- **Why:** no subscription is created until the member submits, so members who abandon leave no
  `incomplete` subscriptions behind, and the form can render before any server call.
- **What is verified:** the server half is what the proof verified.
- **What is not:** the browser half is **not verified** here; it is the Playwright lane's job.
- **Endive change:** Elements' `paymentMethodTypes` option is replaced by
  `allowedPaymentMethodTypes` **(docs)**.

**Changing the card.** `setupIntents.create({ customer, usage: "off_session" })`, then the
browser runs `confirmSetup`. Then set `subscriptions.update(id, { default_payment_method })`. If
an invoice is open (past due), call **`invoices.pay(invoiceId)`**. Observed: changing the default
card does **not** trigger a payment attempt by itself; the next automatic retry was 44.7 h away.
`pay` succeeded at once, and the subscription went `past_due` → `active` in the same second.

**Plan changes.**

- Preview with `invoices.createPreview({ customer, subscription, subscription_details: { items:
  [{ id: itemId, price }], proration_date, proration_behavior: "always_invoice" } })`.
- Then apply with `subscriptions.update(id, { items, proration_date, proration_behavior:
  "always_invoice", payment_behavior: "pending_if_incomplete" })`, passing the **same
  `proration_date`**.
- **Observed for upgrade and downgrade alike:** the invoice equalled the preview to the cent,
  line by line.
  - Upgrade Standard → Premium: +600.
  - Downgrade Premium → Basic: −1100. It produced a negative invoice with `amount_due` 0 and a
    customer balance of −1100, and the next renewal preview then showed `total` 799,
    `amount_due` 0.
- In real time these changes happen seconds into the period, so prorations are whole-period
  amounts. A mid-period proration is **not verified** without a clock.
- Docs **(docs)** suggest a subscription schedule for downgrades at the period end. Webflix must
  choose between an immediate credit and a scheduled change; blueprint §12 does not say which.

**Cancel and resume.**

- `cancel_at_period_end: true`, then `false`, undoes a pending cancellation (it is not the pause
  feature).
- `subscriptions.cancel(id)` cancels immediately.
- With `invoice_now: true, prorate: true`, the immediate cancel produced a **draft** final
  invoice of −1299 and **no refund**, only a pending credit. The adapter must refund explicitly
  if refunds are the policy.

**Refunds.** Find the PaymentIntent of an invoice with `invoicePayments.list({ invoice })` →
`payment.payment_intent`, then `refunds.create({ payment_intent, amount? })`. Observed:

- A partial refund (300) then a refund with no amount refunded exactly the remaining 499.
- `charge.refunded` followed each refund.
- The invoice stayed `paid` with `amount_paid` 799, and the subscription was unaffected. A
  refund changes neither.

**Promotion codes.**

- The creation shape changed in clover: `promotion: { type: "coupon", coupon }`, not `coupon`
  **(docs)**; observed working.
- Apply with `discounts: [{ promotion_code }]`.
- Observed: 50% off 799 gave a total of 399 (discount 400).
- An exhausted code and an expired code are both refused with **HTTP 400,
  `invalid_request_error`, `code: null`**, distinguishable only by message ("This promotion code
  has been used up." / "has expired."). Validate codes before use (`promotionCodes.list({ code,
  active: true })`, then check `expires_at` and `max_redemptions`). Never parse messages.
- A used-up or expired code reads `active: false`.

**Catalogue.**

- Products get custom ids (`webflix_basic`), so the idempotency check is a retrieve.
- Prices are one per plan and currency, found with `prices.list({ lookup_keys: […] })`
  (`webflix.basic.monthly.usd`, `…eur`).
- A changed amount means a new price with `transfer_lookup_key: true`, then archiving the old
  one (`active: false`). Observed: the old price lost its lookup key, exactly one price held the
  key afterwards, and a second pass made **zero writes**.
- Separate prices per currency map one-to-one onto Webflix's per-currency rows. `currency_options`
  on one price is the alternative **(docs)**, not tried.

**Idempotency** (§3 "every mutating call takes an idempotency key"):

| Case | Observed |
| --- | --- |
| Same key, same body | Same object, response header `Idempotent-Replayed: true`, but a **new** `Request-Id` |
| Same key, different body | HTTP 400, `idempotency_error` (`StripeIdempotencyError`): "Keys for idempotent requests can only be used with the same parameters they were first used with." |
| Same key after a **declined** charge (402) | The decline is **replayed** (402, `Idempotent-Replayed: true`); the card is not tried again. A retry after the member fixes the card **needs a new key**, so derive keys from (operation, attempt). |
| Two concurrent requests, one key | One got **409** (`idempotency_key_in_use`); stripe-node retried it and got the replay. Both callers received the same customer. |
| No key passed | stripe-node sends `Idempotency-Key: stripe-node-retry-<uuid>` on every POST when `maxNetworkRetries > 0` |
| The key in events | Each event's `request.idempotency_key` carries the key of the call that caused it, so events can be tied to `billing_operations` rows (observed on the catalogue events). Stripe-initiated events (renewals) have none. |

Docs: keys up to 255 characters, kept at least 24 hours; 500s and 400s are cached; validation
errors, conflicts and rate limits are not **(docs)**.

## 8. What each scenario showed

Full event sequences are in the appendix and in `tools/stripe/fixtures/<scenario>/events.json`.
Times are seconds from the scenario's start.

| Scenario | Result (real time) | Key observations |
| --- | --- | --- |
| catalogue | ok | Second pass: 0 writes. Transfer of a lookup key, then archive. Prices emit legacy `plan.created`/`plan.updated` alongside `price.*`. |
| trial-converts | ok | `trialing` with a pending SetupIntent, a 0.00 `subscription_create` invoice already `paid`, and the card saved asynchronously. The subscription *reads* `active` from the trial end; the event and the draft `subscription_cycle` invoice came 12–47 s later; Stripe would collect about 1 h later (`next_payment_attempt` +60 min). After the attempt: `invoice.paid`, `active`. |
| renewal-recovers | ok, 1 skipped | A card accepted at sign-up (…0341) declines at the first renewal: `charge.failed`, `invoice.payment_failed` with `attempt_count` 1, subscription `past_due`, next Stripe retry in **44.7 h**. Card replaced, then `invoices.pay`, then `paid` and `active`. |
| retries-exhausted | ok, 1 skipped | First failure as above (next retry 45 h). The final state after Stripe gives up needs a clock: **skipped**. |
| three-d-secure | ok, 1 skipped | **First payment:** `requires_action` (redirect to `hooks.stripe.com`), subscription `incomplete`; the member pays the same intent with another card and it becomes `active`. **Abandoned:** stays `incomplete` with an `open` invoice; expiry after 23 h is skipped. **Off-session renewal** with the always-authenticate card: `invoices.pay` gives 402 `invoice_payment_intent_requires_action`, `invoice.payment_action_required`, `past_due`, `attempt_count` 0 and **no scheduled retry**; the member pays on-session with another card and it becomes `active`. |
| plan-change | ok, 1 skipped | Preview equals invoice for upgrade (+600) and downgrade (−1100 as credit). The renewal-versus-preview check needs a clock. |
| cancel-refund | ok | `cancel_at_period_end` sets `cancel_at` **and `canceled_at`** while the subscription stays `active`, and resuming clears both. An immediate cancel emits `customer.subscription.deleted`. Partial then full refund. A prorated cancel gives a draft credit invoice. A trial cancelled before its end becomes `canceled` at the trial end with nothing charged. |
| promotion-codes | ok, 1 skipped | A limit of 1 is enforced (the code goes inactive). Real-time expiry is enforced. Whether a clock customer's expiry follows clock time is skipped. |
| trial-once | ok | Stripe gave the same customer a **second trial** right after the first was canceled. The same card number on two customers has the **same fingerprint**; a different card, a different one. Stripe sent `invoice.upcoming` as soon as each 7-day trial started. |
| idempotency | ok | See §7. |
| delivery-anomalies | ok | See §11. |

## 9. Mapping Stripe states to §5.2

The projection should be computed from the **retrieved** subscription: `status`,
`cancel_at_period_end`, `items.data[].current_period_end` (period end moved to items in basil),
`trial_end`, `ended_at`, `cancellation_details` and the latest invoice. Never from the event
that triggered processing (§11).

| Stripe `status` (and conditions) | Webflix state | Entitled | Notes |
| --- | --- | --- | --- |
| no subscription | `none` | no | |
| `incomplete` | `incomplete` | no | First payment awaiting confirmation or a challenge (observed). Show "confirming your payment". |
| `incomplete_expired` | `none` | no | **Missing from §5.2.** Terminal, 23 h after creation; the invoice is voided **(docs)**; not observed (needs a clock). The account resumes at plan choice. |
| `trialing` | `trialing` | yes | `cancel_at_period_end` means "trial will not convert". |
| `active` | `active` | yes | Includes the roughly 1-hour window after a period starts, when the renewal invoice is draft or open and not yet attempted (observed). Do **not** require a paid latest invoice for `active`. |
| `active` + `cancel_at_period_end` | `active` + flag | until period end | §5.2 calls this `canceled`, but Stripe stays `active` until the period ends. `canceled_at` is already set (observed), so never test `canceled_at` to mean "ended". |
| `past_due` | `past_due` (grace) | yes, during grace | Entered at the first failed renewal attempt (observed). Grace should start at the first failure (`invoice.payment_failed` time; store it, since Stripe has no "past_due since" field). Also covers renewals that need authentication, which Stripe does **not** retry (observed: no `next_payment_attempt`). |
| `past_due` beyond `WEBFLIX_BILLING_GRACE_SEC` | `suspended` | no | **Ambiguous.** Stripe's default retry window is "up to 8 retries within 2 weeks" **(docs)**, so with a 7-day grace Webflix suspends while Stripe is still retrying. That is fine if intended; the projection must then compute suspension from time, not from status. |
| `unpaid` | `suspended` | no | Only if the account's "after all retries fail" setting is *mark unpaid* **(docs)**. Invoices keep being created as drafts (docs contradict each other on this). |
| `paused` | `suspended` | no | Only with `missing_payment_method: "pause"`, the pause endpoint, or the *pause* failure setting (flexible billing) **(docs)**. Not observed. |
| `canceled` after `cancel_at_period_end` or `subscriptions.cancel` | `canceled` | no | Observed `ended_at` set. §5.2's "until period end" belongs to the flag above, not to `canceled`. |
| `canceled` after retries were exhausted | `suspended`, or `canceled` with reason payment failed | no | **Ambiguous and settings-dependent.** If the account setting is *cancel* (implied default **(docs)**: "Subscriptions cancel automatically after up to eight unsuccessful attempts"), "payment recovers and playback returns" (§12) cannot happen on the same subscription: recovery is a new subscription. These settings are **Dashboard-only** **(docs)**, and an unclaimed sandbox has no Dashboard, so the sandbox runs on defaults. Not observed (needs a clock). |

## 10. Events: act on, ignore

Act on these (enqueue, then load the subscription or invoice and write the projection):

| Event | Use |
| --- | --- |
| `customer.subscription.created`, `.updated`, `.deleted` (and `.paused`, `.resumed` if pausing is used) | The projection. Refetch the subscription. |
| `invoice.paid` | Receipts and recovery (§12 "playback returns"). Observed on every paid invoice, including the 0.00 trial invoice: filter `amount_paid > 0` for receipts. |
| `invoice.payment_failed` | "Payment failed" email; the first one starts grace. |
| `invoice.payment_action_required` | Email a link to Webflix's "confirm your payment" page, which uses `invoice.confirmation_secret`. Not retried by Stripe. |
| `setup_intent.succeeded` (for SetupIntents Webflix created, carrying its metadata) | Set `default_payment_method` server-side, so the browser decides nothing (principle 3). |
| `charge.refunded`, `refund.created`, `refund.updated` | Refund records and staff audit. |
| `customer.subscription.trial_will_end` | Optional. Docs: 3 days before. Observed: for 40-second trials it came for only 1 of 11. **Schedule the "trial ending" email from `trial_end`**, not from this event. |
| `charge.dispute.created` (not exercised) | Staff alert **(docs)**. |

Ignore (or log only): `plan.*` (legacy, sent with every recurring price); `price.*` and
`product.*` (Webflix is the source); `customer.updated` (noise from defaults and balances);
`invoice.created`, `invoice.finalized`, `invoice.updated`, `invoice.payment_succeeded` (covered by
`invoice.paid`); `invoice_payment.paid` (a new object type, redundant with `invoice.paid`);
`payment_intent.*`, `charge.succeeded`, `charge.failed` (subscription payments follow from invoice
events); `setup_intent.created` and `setup_intent.requires_action` (**`payment_methods.attach`
now creates a SetupIntent by itself**, observed, so these appear even when Webflix created
none); `payment_method.attached`; `invoiceitem.created`; `invoice.upcoming`; `customer.discount.*`,
`coupon.*`, `promotion_code.*`; `charge.refund.updated` (deprecated **(docs)**).

Docs **(docs)**: answer `invoice.created` with 2xx promptly, or Stripe delays finalisation by up
to 72 hours (for webhook endpoints). Stripe now recommends **thin events** for new integrations;
snapshot events (used here) are versioned by the endpoint's API version.

## 11. Ordering, duplicates, failures, outages (observed)

- **Arrival order is not causal order.** Of 319 first deliveries in the final run, 83 pairs
  arrived in the opposite order to their `created` second (strictly earlier `created`, later
  arrival). Within one second the order is worse still, and ties are common (`created` has
  one-second resolution). Examples:
  - For one invoice at subscription creation: `invoice.finalized` and `invoice.paid` arrived
    **before** `invoice.created` and `customer.subscription.created`. This was in every
    scenario.
  - `customer.subscription.updated` (status `active`) arrived before the `invoice.paid` created a
    second earlier.
  - `invoice_payment.paid` arrived before the `charge.succeeded` created a second earlier.
  - `customer.subscription.deleted` arrived before the `invoiceitem.created` that preceded it.
  - A declined charge's `charge.failed` and `payment_intent.payment_failed` arrived before
    `payment_intent.created`.
- **Duplicates.** Resending one event twice (`stripe events resend`) delivered it three times in
  all. The id and payload were identical; each delivery had a fresh `t=` in `Stripe-Signature`,
  and all verified. Docs **(docs)** add that Stripe may also send "two separate Event objects"
  for one change, so deduplicate by event id *and* write state idempotently.
- **Reordering on demand.** Resending `customer.created` after two `customer.updated` events
  delivered the oldest event last. These sequences are in the `delivery-anomalies` fixtures for
  the adapter's tests.
- **A failed delivery is not retried by `stripe listen`.** After the receiver answered 500, no
  second delivery arrived within 45 s; a resend delivered it. Stripe's own retries ("three times
  over the course of a few hours" in sandboxes, up to three days live **(docs)**) apply to
  webhook endpoints, not CLI sessions.
- **An outage is not replayed.** Events created while no listener ran were **not** delivered
  when a listener started again (0 within 30 s). The Events API listed them
  (`events.list({ type, created: { gte } })`), and a resend delivered them. So in local modes the
  reconciliation job (§5.3) is the only recovery path, and the Stripe lane should test it exactly
  this way.
- **Latency.** p50 1.0 s and p90 1.5 s from `created` to arrival (the CLI signs on forwarding;
  signed minus created had the same p50).
- **Signature header.** It carried `t`, `v1` and `v0`. `v0` is a sandbox-only extra to ignore,
  and parsers must accept unknown entries **(docs)**. Verification used the default 300 s
  tolerance.
- **The signing secret is stable.** `stripe listen --print-secret` returned the same value as
  the running session's "Ready!" line, and the value did not change across restarts. Docs agree
  **(docs)**. It is per CLI session key: a new sandbox means a new secret, which
  `make stripe-listen` reports as CHANGED.
- **`--forward-to` needs an event selection.** In CLI 1.55.14, `stripe listen --forward-to`
  alone fails with "must specify events to forward using --events, --all-snapshot, or
  --all-thin". The docs' webhook pages still show the bare form **(docs)**.

What the processor must therefore tolerate: any order, the same event id more than once, a
second event for the same change, an event about an object that a later event already changed,
and events that never arrive. That means: deduplicate by event id, then **retrieve the current
object from Stripe** and write it with a monotonic guard. Never apply `data.object` blindly or
infer transitions from event types.

## 12. Time: test clocks and the real-time substitute

**Test clocks.** **Not observed**: the sandbox key cannot create them (403). From the docs
**(docs)**:

- **Limits:** 3 customers per clock, 3 subscriptions per customer, 10 quotes not attached to
  customers. The number of clocks per account is not documented.
- **Advances:** at most "two intervals in the future from the shortest subscription" (two years
  if there are none). Time only moves forward: "can't be in the past".
- **Statuses:** `advancing`, then `ready`, or `internal_failure` (after which "future requests to
  advance time will fail"). Events: `test_helpers.test_clock.ready` and others. "It takes a few
  seconds to advance."
- **Rate limits:** API requests made while a clock advances count toward the rate limit.
- **Not simulated:** bank-debit collection; dispute-triggered cancellation.
- **Cleanup:** the docs contradict each other (30 days; 7 days; "subscriptions … canceled 30
  days after the test clock was created").

The proof's clock mode (`tools/stripe/proof/clock.ts`, `timeline.ts`) is ready for a full key.
To wait correctly:

1. Call `advance`. It returns at once with `advancing`.
2. Poll `retrieve` every second until `ready`, recording the milliseconds, the poll count and
   the simulated span. Stop on `internal_failure`, or after 10 minutes.
3. Then wait for the **specific webhook** the step needs, counting only deliveries made after the
   advance began. Webhooks can arrive after `ready`.

Advance timings are **not verified**.

**Real time (what an unclaimed sandbox allows; observed):**

| Mechanic | Observed |
| --- | --- |
| Trial length | Any `trial_end` a few seconds ahead was accepted (40 s used). |
| Trial end | `status` reads `active` from the trial end; `customer.subscription.updated` and the draft `subscription_cycle` invoice come 12–47 s later (about 58 s in one probe). |
| Collection | Stripe schedules the attempt about 1 hour after the draft: `next_payment_attempt` +60 min after early finalisation; finalising early does **not** attempt payment. |
| The attempt | `invoices.finalizeInvoice` then `invoices.pay` gives a real off-session attempt: success, `card_declined`/`generic_decline`, or `invoice_payment_intent_requires_action`. |
| `billing_cycle_anchor: { type: "now" }` (endive object form; the string `"now"` is refused) | No new invoice when applied seconds after creation, so it is useless as a "renew now" button for fresh subscriptions. |
| Retries | `next_payment_attempt` 44.7–45 h after the first decline (Smart Retries). Cannot be waited for. |

Checks that need a clock, recorded as skipped in the fixtures:

- Stripe's own retry.
- The final state after retries are exhausted.
- `incomplete_expired` after 23 h.
- The renewal invoice against its preview after a downgrade.
- Promotion-code expiry for a clock customer.
- A 3-days-before `trial_will_end`.

## 13. Rate limits and costs

**Rate limits.** **(docs)**:

- Sandbox: 25 requests/second globally and 25 per endpoint. Live: 100/s.
- Subscriptions: 10 new invoices per subscription per minute and 20 per day; 200 quantity
  updates per subscription per hour.
- Search: 20 reads/s.
- 429 responses carry `Stripe-Rate-Limited-Reason` (`global-rate`, `endpoint-rate`,
  `global-concurrency`, `endpoint-concurrency`, `resource-specific`). A `lock_timeout` is a 429
  that stripe-node retries.

**Observed: no 429s** in any run. The final run made 147 scenario calls plus 1 probe in 290 s,
with 4 scenarios at a time.

Costs of the final run (real time). The API time column is the sum of response times; calls
overlap.

| Scenario | Wall time | API calls (publishable-key) | API time | Webhook deliveries |
| --- | ---: | ---: | ---: | ---: |
| catalogue | 3 s | 14 (0) | 3.4 s | 5 |
| trial-converts | 68 s | 9 (1) | 7.1 s | 22 |
| renewal-recovers | 84 s | 15 (2) | 11.7 s | 37 |
| retries-exhausted | 72 s | 8 (1) | 6.3 s | 23 |
| three-d-secure | 107 s | 21 (4) | 16.2 s | 61 |
| plan-change | 11 s | 11 (1) | 9.9 s | 33 |
| cancel-refund | 113 s | 25 (3) | 20.3 s | 59 |
| promotion-codes | 68 s | 13 (1) | 7.6 s | 22 |
| trial-once | 12 s | 16 (4) | 11.3 s | 46 |
| idempotency | 3 s | 9 (0) | 3.2 s | 6 |
| delivery-anomalies | 88 s | 6 (0) | 2.5 s | 9 |
| **whole run** | **290 s** | **147 (17)** + 1 probe | | **323** |

The real-time scenarios spend most of their time waiting for Stripe to draft the trial-end
invoice. The delivery scenario spends it on deliberate waits (45 s and 30 s). In clock mode,
expect the advances to dominate. Their cost is not measured.

## 14. API version and stripe-node

- **Pinned: `2026-11-18.endive`.** stripe-node 23.2.0 (`stripe`, exact pin in
  `tools/stripe/package.json`) is generated for it: `apiVersion.js` has
  `ApiVersion = '2026-11-18.endive'`, and its types accept only that literal. The proof sets
  `apiVersion` explicitly (`proof/client.ts`), so a library upgrade that moves the version fails
  the typecheck. The account's default API version is also `2026-11-18.endive`, and `stripe
  listen` rendered events in it ("Ready! You are using Stripe API Version [2026-11-18.endive]").
- **Webhook payload versions.** Payloads follow the account default or the endpoint's own
  version, not the library's **(docs)**. Create production endpoints with `api_version` set to
  the pinned version (allowed with this key: `webhook_endpoints.create` succeeded). With `stripe
  listen`, pass `LATEST=1` only if the pinned version is the latest.
- **Endive and earlier shapes the adapter meets** (observed unless marked **(docs)**):
  - `latest_invoice.confirmation_secret`, not `payment_intent`.
  - `invoice.parent.subscription_details.subscription`, not `invoice.subscription`.
  - Period ends are on `items.data[]`.
  - `invoice_payments` lead from an invoice to its PaymentIntent.
  - `billing_mode: flexible` is the default.
  - `billing_cycle_anchor` on update is `{ type }`.
  - Promotion codes take `promotion: { type: "coupon", coupon }`.
  - Checkout's `ui_mode: "custom"` is refused ("no longer supported. Use `elements`").
  - `payment_method_types` is removed from PaymentIntents and SetupIntents **(docs)**.
  - Trial offers are Stripe's new recommendation for trials **(docs)**; not tried.
- **The `Decimal` hazard (observed).** stripe-node 23 returns `price.unit_amount_decimal` (a
  string on the wire) as a `Decimal` object backed by a `BigInt`. Its `toJSON()` gives the
  string back, so `JSON.stringify(price)` works. But **`structuredClone` drops the prototype**
  and leaves a plain object holding a `BigInt`, on which `JSON.stringify` then throws "Do not
  know how to serialize a BigInt". This crashed the first proof run. On Workers, Queues and
  Durable Object storage use structured cloning, so convert Stripe objects to JSON (or a Webflix
  DTO) before queueing or storing them.
- **Retries.** `maxNetworkRetries: 2` was used. The library retried a 409 by itself and adds
  `stripe-node-retry-<uuid>` idempotency keys when none is given. Pass Webflix's own keys
  always.
- **Error messages.** Messages in this sandbox end with "(This is an unclaimed Stripe sandbox.
  Dashboard links in this error message will not work until the sandbox is claimed.)" and start
  with `[req_…]`. Never show them to members; map `type` and `code` instead.

## 15. What the browser needs

- **From `GET /billing/config`:** the publishable key (`pk_test_…`) only.
- **Card data never touches Webflix.** That is principle 4, and it is enforced by Stripe too:
  card numbers sent with the publishable key outside Stripe.js are refused (§6).
- **Content-Security-Policy** when Stripe is the provider **(docs)** (docs.stripe.com/security/guide):
  - `script-src https://js.stripe.com https://*.js.stripe.com https://maps.googleapis.com`
  - `frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com` (3-D
    Secure)
  - `connect-src https://api.stripe.com https://maps.googleapis.com`
  - With Link: `https://link.com https://*.link.com` in `frame-src` and `connect-src`, and
    `https://*.link.com` in `img-src`.
  - Cross-origin-isolated pages are not supported **(docs)**.
  - Observed in the Stripe.js v3 script (fetched from `js.stripe.com`): it also references
    `q.stripe.com`, `errors.stripe.com`, `merchant-ui-api.stripe.com` and Link hosts. Whether the
    top-level page contacts them is **not verified**. Run the browser suite with a report-only
    policy first.
- **3-D Secure.**
  - Observed: the challenge is a `redirect_to_url` to `hooks.stripe.com/<id>/hosted`, a page
    that only loads Stripe.js.
  - Completing a challenge needs a real browser (Playwright can click Stripe's test-mode
    "Complete" button); it is **not verified** here.
  - With the Payment Element, `confirmPayment`/`confirmSetup` handle it in place.
- **Wallets** **(docs)**:
  - Apple Pay needs domain registration (also for testing) and a real card in Wallet.
  - Google Pay needs a real card and HTTPS with a valid certificate.
  - Link works in sandboxes with any email; any 6-digit code except 000001–000003.
  - Whether `localhost` can be registered is not documented (Stripe suggests ngrok), and the
    docs contradict each other on whether live registration carries over to sandboxes.
  - **Not verified.** Report wallets as "render only" in the results, as §5.5 says.

## 16. Sandbox lifecycle

- **Expiry.** The CLI says "expires 2026-11-28 (in 7 days)" and treats the sandbox as expired
  from 00:00 UTC that day. `make stripe-sandbox` replaces it once fewer than 24 h remain (with
  `STRIPE_SANDBOX_MIN_HOURS`), or as soon as Stripe answers 401.
- **What breaks at expiry (expected).** The key, the webhook signing secret, every object id,
  and the fixtures' relationship to live data. Fixtures do not depend on the sandbox (ids are
  rewritten). The actual behaviour at expiry is **not verified**.
- **How the tooling recovers.**
  - `make stripe-sandbox` creates a new sandbox. Unit-tested paths: the stored key rejected;
    near expiry; the CLI clearing an expired profile, followed by a second attempt.
  - The new sandbox has an empty catalogue, and the catalogue sync rebuilds it on first use
    (observed on the fresh sandbox).
  - `make stripe-listen` captures the new signing secret and flags the change; running modes
    must be restarted with it.
  - Each replacement is recorded in `.cache/stripe/history.jsonl`, so `make stripe-status` can
    list what still exists on Stripe's side.
- **Claiming.**
  - Who: the owner, with a Stripe account. It is the owner's decision and was not done.
  - How: `make stripe-claim` opens the claim page.
  - After claiming: the CLI says to run `stripe login` for "permanent keys"; a full test key from
    the claimed sandbox can then be given to `make stripe-use-key`, after which `make
    stripe-proof` runs in clock mode.
  - Whether the original sandbox key keeps working after a claim: **not verified**.
- **Deleting a sandbox** needs a logged-in account (`stripe sandboxes delete <acct> --confirm`,
  CLI source). The tooling cannot and does not.

## 17. Where blueprint §5 is wrong or incomplete

| # | Blueprint text | What was observed | Proposed change |
| --- | --- | --- | --- |
| 1 | §1, §5.5: "Stripe needs nothing from the owner … proven against real Stripe in this milestone"; "Time: Stripe test clocks drive renewals, failures and recovery" | The anonymous sandbox key may not create test clocks (403), nor customer sessions, tax calculations or meters. | Keep the anonymous sandbox for everything else, and add a **real-time lane** (40-second trials, then finalize and `pay`, as in `tools/stripe/proof`) for renewal, failure and recovery. Make the clock-based checks (retry schedule, retries exhausted, 23 h expiry, mid-period proration, renewal against preview) conditional on a full test key: the owner claims the sandbox, or supplies their own test keys, through `make stripe-use-key`. Until then they **skip with that reason**, never pass. |
| 2 | §5.5: "with the Stripe CLI not logged in, `stripe sandbox create`…" | It needs `--email` (or `--from-git`), and the CLI falls back to a browser login on failure. | Specify `stripe sandboxes create --email <address> --non-interactive`. Use a placeholder address unless the owner wants the claim form prefilled. Treat a login fallback as a failure. |
| 3 | §5.5: "runs with a repository-local profile … Verify the exact flags" | `--config` alone leaves the credentials fallback file, plugins and login state in `~/.config/stripe`, and the update check writes `~/.stripe/state`. | `XDG_CONFIG_HOME` + `--config` + a non-`default` `--project-name` + `STRIPE_NO_UPDATE_CHECK` (+ `HOME` as a guard), as in `stripe-cli.ts`. |
| 4 | §5.5: "`stripe listen --forward-to`, run as a managed sidecar" | `--forward-to` without `--events`/`--all-snapshot`/`--all-thin` exits with an error (1.55.14). `stripe listen` neither retries failed deliveries nor replays an outage. | Use `--all-snapshot` (or the adapter's event list). The Stripe lane's "after an outage" journey (§12) must use **reconciliation** (Events API or retrieving objects), not redelivery. |
| 5 | §5.2: `canceled` = "until period end" | Stripe keeps `active` + `cancel_at_period_end` until the end (with `canceled_at` already set), then `canceled`. | `canceled` means ended (not entitled). "Canceling" is `active`/`trialing` + `cancel_at_period_end`, which §5.2 already allows as a flag. |
| 6 | §5.2 lists 7 states | Stripe also has `incomplete_expired`, `unpaid` and `paused`. | Map `incomplete_expired` to `none`, and `unpaid`/`paused` to `suspended` (§9). Add a `suspended_reason`. |
| 7 | §5.2: `past_due` "provider is retrying"; grace 7 days | Authentication-required renewals are `past_due` with **no** retries. Stripe's default window is about 2 weeks **(docs)**. | Grace starts at the first failed attempt (store it), applies whether or not Stripe retries, and suspension is computed from time. Document that Webflix may suspend before Stripe stops retrying. |
| 8 | §12: "a renewal fails … then suspends; payment recovers and playback returns" | Whether recovery after suspension is possible on the same subscription depends on the Dashboard-only "after all retries fail" setting (default implied: cancel **(docs)**). The unclaimed sandbox cannot change it. | Decide the setting (*mark unpaid* or *pause* keeps the subscription recoverable). Record it in the adapter's configuration documentation, and make the journey's recovery branch match. With *cancel*, recovery is resubscribing. |
| 9 | §5.3: "processing never trusts event order … or applies the event's object guarded by its provider timestamp" | `created` has 1-second resolution and many events share it; `invoice.paid` arrived before `invoice.created` for the same invoice. | Drop the "apply the event's object guarded by timestamp" option. **Always retrieve** the subscription (and the latest invoice) and write it with a version guard. Use `event.request.idempotency_key` to link events to `billing_operations`. |
| 10 | §5.4: "one trial per account and per payment fingerprint" | Stripe enforces neither: it granted a second trial to the same customer. `card.fingerprint` is stable across customers for the same card. Docs: wallets may expose a tokenised number **(docs)**. | Webflix enforces both, with a `trial_fingerprints` table checked before creating a trial subscription; the fingerprint comes from the confirmed SetupIntent's payment method. That check needs a two-step flow: confirm the card with a SetupIntent first, then create the trial subscription with that payment method. Note the wallet caveat. |
| 11 | §5.4: "A 'trial ending' email goes out 3 days before the end" | `trial_will_end` was unreliable for short trials (1 of 11). | Schedule the email from `trial_end`; treat the event as a hint. |
| 12 | §5.4: Stripe's own trial model | Stripe now recommends **trial offers** for new integrations (endive, flexible billing) **(docs)**; this proof used `trial_period_days`. | Decide between trial offers and `trial_period_days` before the adapter is written. Trial offers are not verified here. |
| 13 | §5.4: promo codes | Exhausted and expired codes are refused with `code: null`. | Add `validatePromotionCode` to the port. It reads the code (`active`, `expires_at`, `times_redeemed`/`max_redemptions`) before applying it, and maps to Webflix error codes. |
| 14 | §5.4: tax "is a provider setting (`automatic_tax`)" | Tax endpoints are refused for the sandbox key. | `automatic_tax` is **not verified**. Keep it off in the sandbox lane. |
| 15 | §5.5: "Stripe test cards cover success, each decline reason and a required challenge" | A challenge cannot be completed without a browser, and card numbers cannot be sent outside Stripe.js. | Server-side checks use test PaymentMethod ids (`pm_card_*`). The challenge journey belongs to the Playwright suite. |
| 16 | §5.6, §3: idempotency keys "derived from a Webflix operation id" | A declined charge is replayed under the same key. | Derive keys from (operation id, attempt number); a new attempt after the member changes card gets a new key. |
| 17 | §5.5: the Payment Element | `customer_sessions` is refused for the sandbox key. | Do not depend on CustomerSession (saved cards in the Payment Element) in the sandbox lane. |
| 18 | §2.1 (BLUEPRINT.md): Queues and Durable Objects carry jobs | stripe-node objects contain `Decimal`/`BigInt` that do not survive structured cloning as JSON. | Queue payloads carry event ids and Webflix DTOs, never raw stripe-node objects. |
| 19 | §5.5: "a temporary Stripe sandbox … supplies working test keys" | The CLI prints the secret key (and, on creation, the claim link) to stdout, on creation and on every later `sandboxes create`. | Any tooling must capture and filter that output (as `tools/stripe` does). |

## 18. Not verified

- Completing a 3-D Secure challenge; the Payment Element, the deferred-intent flow, wallets and
  CSP in a real browser.
- Everything that needs a test clock:
  - advance timings;
  - Stripe's retry schedule after the first decline;
  - the final state after retries (and its defaults);
  - `incomplete_expired` after 23 h;
  - `trial_will_end` 3 days before a 7-day trial;
  - mid-period prorations;
  - the renewal invoice after a downgrade against its preview;
  - promotion-code expiry against clock time.
- Whether the dunning settings can be set by API (the docs say Dashboard only; no API was found
  or probed).
- Sandbox expiry itself, and what the tooling sees at that moment (the code paths are
  unit-tested).
- Claiming (`make stripe-claim` was never run), and what the original key can do after a claim.
- Real webhook endpoints' retry behaviour (a `stripe listen` session was used throughout).
- `automatic_tax`, trial offers, pausing (only the refusal to pause a trialing subscription was
  seen), subscription schedules beyond creation, Checkout in `elements` mode, `currency_options`.
- `make stripe-use-key` with its interactive prompt, and with a full (non-sandbox) key.
- Platforms other than macOS arm64. The CLI package has binaries for darwin-x64, linux-x64,
  linux-arm64 and win32-x64.

## 19. Fixtures (`tools/stripe/fixtures`)

The adapter's unit-test corpus, from one run (the final run, real-time mode):

- `index.json`: run metadata, including the API version, stripe-node and CLI versions, time
  mode, scrub statistics (692 ids, 20 emails, 5 fingerprints rewritten), totals and per-scenario
  costs.
- `<scenario>/scenario.json`: steps with timings, observations and expectations, skipped
  checks, API calls (method, path, status, timing, key kind, idempotency key, replay flag),
  delivery counts, event-type histogram and order inversions.
- `<scenario>/events.json`: every delivery in arrival order. Each entry has `received_offset_ms`,
  `delivery_of_id` (2 or more means a duplicate), `signature_verified`, `responded_with`, and the
  full scrubbed event.
- `<scenario>/responses.json`: the key API responses, and the errors with their raw Stripe error
  bodies.

**The scrubber** (`tools/stripe/src/scrub.ts`, tested in `test/scrub.test.ts`) is deterministic
and consistent across the whole corpus. It is also idempotent: scrubbing scrubbed data changes
nothing.

| Value | Treatment |
| --- | --- |
| Object ids | Rewritten with the prefix kept: `cus_WFX…`, `il_tmp_WFX…`, `upcoming_in_WFX…` |
| Emails | `member-<n>@example.test` |
| Card fingerprints | Rewritten consistently, so equality is preserved |
| Keys, signing secrets, masked keys, claim links | `[redacted <kind>]` |
| Client secrets | Keep the rewritten intent id: `pi_WFX…_secret_[redacted]` |
| Client IP addresses and user agents | Removed |
| Stripe-hosted capability URLs (invoices, receipts, 3-D Secure pages) | Host kept, path dropped |

Before writing, `writeFixtures` refuses output in which any secret pattern or any un-rewritten
id-shaped token survives. The repository secret scan then covers the committed files.

Signatures are not stored. Tests re-sign payloads with `stripe.webhooks.generateTestHeaderStringAsync`
and a test secret.

**Commands that produced the evidence** (all from the repository root):

- `make stripe-sandbox` (twice: create, then reuse);
- `make stripe-listen NAME=probe FORWARD_TO=http://localhost:5549/webhook`, run twice to check
  the secret's stability, plus `make stripe-listen-stop` and `make stripe-status`;
- `make stripe-proof` (final run `rmwqr4nao`, 2026-11-21 18:38–18:43 UTC);
- `node tools/stripe/proof/refixture.ts`;
- `make stripe-use-key FROM=<0600 file under .cache/stripe>` with the sandbox's own keys,
  then restored;
- `make stripe-reset` against a backup of `.cache/stripe`, then restored and reused;
- scratch probes for permissions, real-time mechanics and early finalisation, recorded in this
  document;
- the isolation check: `ls -la ~/.config/stripe ~/.stripe` (both absent) and
  `security find-generic-password -s StripeCLI` (exit 44).

## Appendix: event sequences

Generated by `node tools/stripe/proof/report.ts` from the fixtures. "arrived" is seconds from the
scenario's start; "created" is the event's `created` relative to the first event (whole
seconds). Rows are in arrival order.

#### catalogue: Catalogue sync by lookup key, two currencies

| # | arrived (s) | created (s) | event | object | state |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 3.0 | 0 | `price.updated` | price |  |
| 2 | 3.0 | 0 | `plan.created` | plan |  |
| 3 | 3.1 | 0 | `price.created` | price |  |
| 4 | 3.3 | 0 | `plan.updated` | plan |  |
| 5 | 3.4 | 0 | `price.updated` | price |  |

#### trial-converts: Trial with the card collected up front converts to paid

| # | arrived (s) | created (s) | event | object | state |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.9 | 0 | `customer.created` | customer |  |
| 2 | 1.9 | 1 | `setup_intent.created` | setup_intent | status=requires_payment_method |
| 3 | 2.2 | 1 | `invoice.finalized` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 4 | 2.3 | 1 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 5 | 2.3 | 1 | `customer.updated` | customer |  |
| 6 | 2.4 | 1 | `customer.subscription.created` | subscription | status=trialing |
| 7 | 2.5 | 1 | `invoice.created` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 8 | 2.5 | 1 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 9 | 3.1 | 2 | `payment_method.attached` | payment_method |  |
| 10 | 3.1 | 2 | `setup_intent.succeeded` | setup_intent | status=succeeded |
| 11 | 3.4 | 3 | `customer.subscription.updated` | subscription | status=trialing |
| 12 | 63.4 | 63 | `invoice.created` | invoice | status=draft billing_reason=subscription_cycle attempt_count=0 |
| 13 | 63.5 | 63 | `customer.subscription.updated` | subscription | status=active |
| 14 | 64.8 | 64 | `payment_intent.created` | payment_intent | status=requires_payment_method |
| 15 | 65.0 | 64 | `invoice.updated` | invoice | status=open billing_reason=subscription_cycle attempt_count=0 |
| 16 | 65.0 | 64 | `invoice.finalized` | invoice | status=open billing_reason=subscription_cycle attempt_count=0 |
| 17 | 66.9 | 66 | `invoice_payment.paid` | invoice_payment | status=paid |
| 18 | 67.1 | 66 | `payment_intent.succeeded` | payment_intent | status=succeeded |
| 19 | 67.2 | 66 | `charge.succeeded` | charge | status=succeeded amount_refunded=0 |
| 20 | 67.3 | 66 | `invoice.paid` | invoice | status=paid billing_reason=subscription_cycle attempt_count=1 |
| 21 | 67.4 | 66 | `invoice.updated` | invoice | status=paid billing_reason=subscription_cycle attempt_count=1 |
| 22 | 67.5 | 66 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_cycle attempt_count=1 |

#### renewal-recovers: Renewal declines, Stripe retries, card replaced, invoice paid

| # | arrived (s) | created (s) | event | object | state |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.8 | 0 | `customer.created` | customer |  |
| 2 | 1.9 | 1 | `setup_intent.created` | setup_intent | status=requires_payment_method |
| 3 | 2.1 | 1 | `invoice.finalized` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 4 | 2.2 | 1 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 5 | 2.3 | 1 | `customer.updated` | customer |  |
| 6 | 2.4 | 1 | `customer.subscription.created` | subscription | status=trialing |
| 7 | 2.4 | 1 | `invoice.created` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 8 | 2.5 | 1 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 9 | 2.9 | 2 | `payment_method.attached` | payment_method |  |
| 10 | 3.0 | 2 | `setup_intent.succeeded` | setup_intent | status=succeeded |
| 11 | 5.1 | 5 | `customer.subscription.updated` | subscription | status=trialing |
| 12 | 74.8 | 74 | `customer.subscription.updated` | subscription | status=active |
| 13 | 74.8 | 74 | `invoice.created` | invoice | status=draft billing_reason=subscription_cycle attempt_count=0 |
| 14 | 75.8 | 75 | `payment_intent.created` | payment_intent | status=requires_payment_method |
| 15 | 75.9 | 75 | `invoice.updated` | invoice | status=open billing_reason=subscription_cycle attempt_count=0 |
| 16 | 76.0 | 75 | `invoice.finalized` | invoice | status=open billing_reason=subscription_cycle attempt_count=0 |
| 17 | 77.8 | 77 | `charge.failed` | charge | status=failed amount_refunded=0 |
| 18 | 77.9 | 77 | `payment_intent.payment_failed` | payment_intent | status=requires_payment_method |
| 19 | 78.0 | 77 | `invoice.updated` | invoice | status=open billing_reason=subscription_cycle attempt_count=1 |
| 20 | 78.1 | 77 | `customer.updated` | customer |  |
| 21 | 78.1 | 77 | `customer.subscription.updated` | subscription | status=past_due |
| 22 | 78.9 | 78 | `invoice.updated` | invoice | status=open billing_reason=subscription_cycle attempt_count=1 |
| 23 | 78.9 | 78 | `invoice.payment_failed` | invoice | status=open billing_reason=subscription_cycle attempt_count=1 |
| 24 | 79.7 | 79 | `setup_intent.created` | setup_intent | status=requires_payment_method |
| 25 | 80.6 | 80 | `payment_method.attached` | payment_method |  |
| 26 | 80.7 | 80 | `setup_intent.succeeded` | setup_intent | status=succeeded |
| 27 | 81.6 | 81 | `customer.subscription.updated` | subscription | status=past_due |
| 28 | 81.7 | 81 | `setup_intent.created` | setup_intent | status=succeeded |
| 29 | 81.7 | 81 | `setup_intent.succeeded` | setup_intent | status=succeeded |
| 30 | 83.5 | 83 | `invoice_payment.paid` | invoice_payment | status=paid |
| 31 | 83.6 | 83 | `payment_intent.succeeded` | payment_intent | status=succeeded |
| 32 | 83.7 | 83 | `charge.succeeded` | charge | status=succeeded amount_refunded=0 |
| 33 | 83.8 | 83 | `invoice.paid` | invoice | status=paid billing_reason=subscription_cycle attempt_count=1 |
| 34 | 83.9 | 83 | `customer.updated` | customer |  |
| 35 | 84.0 | 83 | `customer.subscription.updated` | subscription | status=active |
| 36 | 84.0 | 83 | `invoice.updated` | invoice | status=paid billing_reason=subscription_cycle attempt_count=1 |
| 37 | 84.2 | 83 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_cycle attempt_count=1 |

#### retries-exhausted: Renewal left unpaid until Stripe stops retrying

| # | arrived (s) | created (s) | event | object | state |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.8 | 0 | `customer.created` | customer |  |
| 2 | 1.8 | 1 | `setup_intent.created` | setup_intent | status=requires_payment_method |
| 3 | 1.9 | 1 | `invoice.finalized` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 4 | 2.2 | 1 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 5 | 2.3 | 1 | `customer.updated` | customer |  |
| 6 | 2.4 | 1 | `customer.subscription.created` | subscription | status=trialing |
| 7 | 2.4 | 1 | `invoice.created` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 8 | 2.5 | 1 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 9 | 2.8 | 2 | `payment_method.attached` | payment_method |  |
| 10 | 2.9 | 2 | `setup_intent.succeeded` | setup_intent | status=succeeded |
| 11 | 3.7 | 3 | `customer.subscription.updated` | subscription | status=trialing |
| 12 | 68.1 | 67 | `invoice.created` | invoice | status=draft billing_reason=subscription_cycle attempt_count=0 |
| 13 | 68.2 | 67 | `customer.subscription.updated` | subscription | status=active |
| 14 | 69.4 | 68 | `payment_intent.created` | payment_intent | status=requires_payment_method |
| 15 | 69.5 | 69 | `invoice.updated` | invoice | status=open billing_reason=subscription_cycle attempt_count=0 |
| 16 | 69.5 | 69 | `invoice.finalized` | invoice | status=open billing_reason=subscription_cycle attempt_count=0 |
| 17 | 71.1 | 70 | `payment_intent.payment_failed` | payment_intent | status=requires_payment_method |
| 18 | 71.1 | 70 | `charge.failed` | charge | status=failed amount_refunded=0 |
| 19 | 71.2 | 70 | `invoice.updated` | invoice | status=open billing_reason=subscription_cycle attempt_count=1 |
| 20 | 71.3 | 70 | `customer.updated` | customer |  |
| 21 | 71.4 | 70 | `customer.subscription.updated` | subscription | status=past_due |
| 22 | 71.9 | 71 | `invoice.updated` | invoice | status=open billing_reason=subscription_cycle attempt_count=1 |
| 23 | 72.1 | 71 | `invoice.payment_failed` | invoice | status=open billing_reason=subscription_cycle attempt_count=1 |

#### three-d-secure: 3-D Secure on first payment and on an off-session renewal

| # | arrived (s) | created (s) | event | object | state |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.7 | 0 | `customer.created` | customer |  |
| 2 | 2.1 | 1 | `payment_intent.created` | payment_intent | status=requires_payment_method |
| 3 | 2.3 | 1 | `invoice.finalized` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 4 | 2.3 | 1 | `invoice.created` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 5 | 2.3 | 1 | `customer.updated` | customer |  |
| 6 | 2.3 | 1 | `customer.subscription.created` | subscription | status=incomplete |
| 7 | 2.8 | 2 | `customer.updated` | customer |  |
| 8 | 2.9 | 2 | `payment_intent.requires_action` | payment_intent | status=requires_action |
| 9 | 3.0 | 2 | `invoice.payment_failed` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 10 | 3.1 | 2 | `invoice.payment_action_required` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 11 | 3.2 | 2 | `invoice.updated` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 12 | 5.2 | 4 | `invoice_payment.paid` | invoice_payment | status=paid |
| 13 | 5.2 | 4 | `charge.succeeded` | charge | status=succeeded amount_refunded=0 |
| 14 | 5.3 | 4 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 15 | 5.4 | 4 | `payment_method.attached` | payment_method |  |
| 16 | 5.5 | 5 | `customer.subscription.updated` | subscription | status=active |
| 17 | 5.6 | 5 | `customer.updated` | customer |  |
| 18 | 5.6 | 4 | `payment_intent.succeeded` | payment_intent | status=succeeded |
| 19 | 5.8 | 4 | `invoice.updated` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 20 | 5.8 | 4 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 21 | 6.0 | 5 | `customer.created` | customer |  |
| 22 | 7.1 | 6 | `payment_intent.created` | payment_intent | status=requires_payment_method |
| 23 | 7.2 | 7 | `invoice.created` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 24 | 7.3 | 7 | `invoice.finalized` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 25 | 7.3 | 6 | `customer.updated` | customer |  |
| 26 | 7.4 | 7 | `customer.subscription.created` | subscription | status=incomplete |
| 27 | 8.2 | 7 | `invoice.payment_failed` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 28 | 8.3 | 7 | `invoice.payment_action_required` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 29 | 8.4 | 8 | `invoice.updated` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 30 | 8.5 | 8 | `customer.updated` | customer |  |
| 31 | 8.6 | 7 | `payment_intent.requires_action` | payment_intent | status=requires_action |
| 32 | 8.8 | 8 | `customer.created` | customer |  |
| 33 | 9.4 | 9 | `payment_method.attached` | payment_method |  |
| 34 | 10.8 | 10 | `invoice.finalized` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 35 | 10.9 | 10 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 36 | 10.9 | 10 | `customer.updated` | customer |  |
| 37 | 11.0 | 10 | `customer.subscription.created` | subscription | status=trialing |
| 38 | 11.1 | 10 | `setup_intent.created` | setup_intent | status=requires_action |
| 39 | 11.1 | 10 | `setup_intent.requires_action` | setup_intent | status=requires_action |
| 40 | 11.2 | 10 | `invoice.created` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 41 | 11.3 | 10 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 42 | 96.5 | 96 | `invoice.created` | invoice | status=draft billing_reason=subscription_cycle attempt_count=0 |
| 43 | 96.5 | 96 | `customer.subscription.updated` | subscription | status=active |
| 44 | 97.7 | 97 | `invoice.updated` | invoice | status=open billing_reason=subscription_cycle attempt_count=0 |
| 45 | 97.7 | 97 | `payment_intent.created` | payment_intent | status=requires_payment_method |
| 46 | 97.8 | 97 | `invoice.finalized` | invoice | status=open billing_reason=subscription_cycle attempt_count=0 |
| 47 | 99.0 | 98 | `customer.updated` | customer |  |
| 48 | 99.0 | 98 | `customer.subscription.updated` | subscription | status=past_due |
| 49 | 99.1 | 98 | `payment_intent.requires_action` | payment_intent | status=requires_action |
| 50 | 99.2 | 98 | `payment_intent.payment_failed` | payment_intent | status=requires_payment_method |
| 51 | 99.3 | 98 | `invoice.payment_failed` | invoice | status=open billing_reason=subscription_cycle attempt_count=0 |
| 52 | 99.3 | 98 | `invoice.payment_action_required` | invoice | status=open billing_reason=subscription_cycle attempt_count=0 |
| 53 | 99.4 | 98 | `invoice.updated` | invoice | status=open billing_reason=subscription_cycle attempt_count=0 |
| 54 | 106.2 | 105 | `invoice_payment.paid` | invoice_payment | status=paid |
| 55 | 106.3 | 105 | `payment_intent.succeeded` | payment_intent | status=succeeded |
| 56 | 106.4 | 105 | `charge.succeeded` | charge | status=succeeded amount_refunded=0 |
| 57 | 106.6 | 106 | `customer.subscription.updated` | subscription | status=active |
| 58 | 106.7 | 106 | `customer.updated` | customer |  |
| 59 | 106.7 | 105 | `invoice.paid` | invoice | status=paid billing_reason=subscription_cycle attempt_count=1 |
| 60 | 106.9 | 105 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_cycle attempt_count=1 |
| 61 | 106.9 | 105 | `invoice.updated` | invoice | status=paid billing_reason=subscription_cycle attempt_count=1 |

#### plan-change: Upgrade and downgrade against their proration previews

| # | arrived (s) | created (s) | event | object | state |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.7 | 0 | `customer.created` | customer |  |
| 2 | 2.1 | 1 | `invoice.created` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 3 | 2.1 | 1 | `payment_intent.created` | payment_intent | status=requires_payment_method |
| 4 | 2.2 | 1 | `invoice.finalized` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 5 | 2.3 | 1 | `customer.updated` | customer |  |
| 6 | 2.3 | 1 | `customer.subscription.created` | subscription | status=incomplete |
| 7 | 3.8 | 2 | `invoice_payment.paid` | invoice_payment | status=paid |
| 8 | 3.9 | 2 | `charge.succeeded` | charge | status=succeeded amount_refunded=0 |
| 9 | 4.0 | 3 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 10 | 4.2 | 2 | `payment_method.attached` | payment_method |  |
| 11 | 4.2 | 3 | `customer.subscription.updated` | subscription | status=active |
| 12 | 4.3 | 2 | `payment_intent.succeeded` | payment_intent | status=succeeded |
| 13 | 4.4 | 3 | `invoice.updated` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 14 | 4.5 | 3 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 15 | 7.2 | 6 | `invoice_payment.paid` | invoice_payment | status=paid |
| 16 | 7.3 | 6 | `charge.succeeded` | charge | status=succeeded amount_refunded=0 |
| 17 | 7.4 | 6 | `invoice.finalized` | invoice | status=paid billing_reason=subscription_update attempt_count=1 |
| 18 | 7.6 | 6 | `invoice.paid` | invoice | status=paid billing_reason=subscription_update attempt_count=1 |
| 19 | 7.6 | 6 | `customer.subscription.updated` | subscription | status=active |
| 20 | 7.7 | 5 | `payment_intent.created` | payment_intent | status=requires_payment_method |
| 21 | 7.8 | 6 | `payment_intent.succeeded` | payment_intent | status=succeeded |
| 22 | 7.8 | 6 | `invoice.created` | invoice | status=paid billing_reason=subscription_update attempt_count=1 |
| 23 | 7.9 | 6 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_update attempt_count=1 |
| 24 | 8.0 | 6 | `invoiceitem.created` | invoiceitem |  |
| 25 | 8.0 | 6 | `invoiceitem.created` | invoiceitem |  |
| 26 | 10.1 | 9 | `invoice.finalized` | invoice | status=paid billing_reason=subscription_update attempt_count=0 |
| 27 | 10.2 | 9 | `invoice.paid` | invoice | status=paid billing_reason=subscription_update attempt_count=0 |
| 28 | 10.3 | 9 | `customer.updated` | customer |  |
| 29 | 10.3 | 9 | `customer.subscription.updated` | subscription | status=active |
| 30 | 10.5 | 9 | `invoice.created` | invoice | status=paid billing_reason=subscription_update attempt_count=0 |
| 31 | 10.6 | 9 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_update attempt_count=0 |
| 32 | 10.6 | 9 | `invoiceitem.created` | invoiceitem |  |
| 33 | 10.7 | 9 | `invoiceitem.created` | invoiceitem |  |

#### cancel-refund: Cancel at period end, resume, cancel now, refunds, cancelled trial

| # | arrived (s) | created (s) | event | object | state |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.7 | 0 | `customer.created` | customer |  |
| 2 | 1.9 | 0 | `payment_intent.created` | payment_intent | status=requires_payment_method |
| 3 | 2.1 | 1 | `invoice.finalized` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 4 | 2.1 | 1 | `invoice.created` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 5 | 2.1 | 0 | `customer.updated` | customer |  |
| 6 | 2.2 | 1 | `customer.subscription.created` | subscription | status=incomplete |
| 7 | 4.0 | 2 | `invoice_payment.paid` | invoice_payment | status=paid |
| 8 | 4.1 | 2 | `charge.succeeded` | charge | status=succeeded amount_refunded=0 |
| 9 | 4.2 | 3 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 10 | 4.2 | 2 | `payment_method.attached` | payment_method |  |
| 11 | 4.3 | 3 | `customer.subscription.updated` | subscription | status=active |
| 12 | 4.4 | 2 | `payment_intent.succeeded` | payment_intent | status=succeeded |
| 13 | 4.5 | 3 | `invoice.updated` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 14 | 4.6 | 3 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 15 | 6.0 | 5 | `customer.subscription.updated` | subscription | status=active cancel_at_period_end=true |
| 16 | 6.8 | 6 | `customer.subscription.updated` | subscription | status=active |
| 17 | 7.4 | 6 | `customer.subscription.deleted` | subscription | status=canceled |
| 18 | 8.7 | 7 | `refund.created` | refund | status=succeeded |
| 19 | 8.8 | 7 | `charge.refunded` | charge | status=succeeded amount_refunded=300 |
| 20 | 9.7 | 8 | `refund.created` | refund | status=succeeded |
| 21 | 9.8 | 8 | `charge.refunded` | charge | status=succeeded amount_refunded=799 refunded=true |
| 22 | 10.2 | 9 | `refund.updated` | refund | status=succeeded |
| 23 | 10.3 | 9 | `refund.updated` | refund | status=succeeded |
| 24 | 10.3 | 9 | `charge.refund.updated` | refund | status=succeeded |
| 25 | 10.4 | 9 | `charge.refund.updated` | refund | status=succeeded |
| 26 | 10.9 | 10 | `customer.created` | customer |  |
| 27 | 12.4 | 11 | `payment_intent.created` | payment_intent | status=requires_payment_method |
| 28 | 12.5 | 11 | `invoice.created` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 29 | 12.6 | 11 | `invoice.finalized` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 30 | 12.6 | 11 | `customer.updated` | customer |  |
| 31 | 12.7 | 11 | `customer.subscription.created` | subscription | status=incomplete |
| 32 | 14.2 | 13 | `invoice_payment.paid` | invoice_payment | status=paid |
| 33 | 14.4 | 12 | `charge.succeeded` | charge | status=succeeded amount_refunded=0 |
| 34 | 14.5 | 13 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 35 | 14.5 | 12 | `payment_method.attached` | payment_method |  |
| 36 | 14.6 | 13 | `customer.subscription.updated` | subscription | status=active |
| 37 | 14.7 | 12 | `payment_intent.succeeded` | payment_intent | status=succeeded |
| 38 | 14.8 | 13 | `invoice.updated` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 39 | 14.9 | 13 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 40 | 15.9 | 15 | `invoice.created` | invoice | status=draft billing_reason=subscription_cycle attempt_count=0 |
| 41 | 16.0 | 15 | `customer.subscription.deleted` | subscription | status=canceled |
| 42 | 16.0 | 14 | `invoiceitem.created` | invoiceitem |  |
| 43 | 22.1 | 21 | `refund.created` | refund | status=succeeded |
| 44 | 22.3 | 21 | `charge.refunded` | charge | status=succeeded amount_refunded=1299 refunded=true |
| 45 | 22.6 | 21 | `refund.updated` | refund | status=succeeded |
| 46 | 22.7 | 22 | `charge.refund.updated` | refund | status=succeeded |
| 47 | 22.7 | 22 | `customer.created` | customer |  |
| 48 | 23.8 | 22 | `setup_intent.created` | setup_intent | status=requires_payment_method |
| 49 | 23.8 | 23 | `invoice.finalized` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 50 | 23.9 | 23 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 51 | 24.0 | 22 | `customer.updated` | customer |  |
| 52 | 24.0 | 23 | `customer.subscription.created` | subscription | status=trialing |
| 53 | 24.1 | 23 | `invoice.created` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 54 | 24.2 | 23 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 55 | 24.6 | 23 | `payment_method.attached` | payment_method |  |
| 56 | 24.7 | 23 | `setup_intent.succeeded` | setup_intent | status=succeeded |
| 57 | 25.2 | 24 | `customer.subscription.updated` | subscription | status=trialing |
| 58 | 25.8 | 25 | `customer.subscription.updated` | subscription | status=trialing cancel_at_period_end=true |
| 59 | 112.0 | 111 | `customer.subscription.deleted` | subscription | status=canceled cancel_at_period_end=true |

#### promotion-codes: Promotion code redemption limit and expiry

| # | arrived (s) | created (s) | event | object | state |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 1.0 | 0 | `coupon.created` | coupon |  |
| 2 | 1.3 | 0 | `promotion_code.created` | promotion_code |  |
| 3 | 1.9 | 1 | `promotion_code.created` | promotion_code |  |
| 4 | 2.3 | 1 | `customer.created` | customer |  |
| 5 | 3.6 | 2 | `payment_intent.created` | payment_intent | status=requires_payment_method |
| 6 | 3.7 | 2 | `invoice.created` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 7 | 3.8 | 2 | `invoice.finalized` | invoice | status=open billing_reason=subscription_create attempt_count=0 |
| 8 | 3.8 | 2 | `customer.updated` | customer |  |
| 9 | 3.9 | 2 | `customer.discount.created` | discount |  |
| 10 | 4.0 | 2 | `customer.discount.deleted` | discount |  |
| 11 | 4.3 | 2 | `promotion_code.updated` | promotion_code |  |
| 12 | 4.3 | 2 | `customer.subscription.created` | subscription | status=incomplete |
| 13 | 5.7 | 4 | `invoice_payment.paid` | invoice_payment | status=paid |
| 14 | 5.8 | 4 | `charge.succeeded` | charge | status=succeeded amount_refunded=0 |
| 15 | 5.9 | 4 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 16 | 6.0 | 4 | `payment_method.attached` | payment_method |  |
| 17 | 6.1 | 4 | `customer.subscription.updated` | subscription | status=active |
| 18 | 6.1 | 4 | `payment_intent.succeeded` | payment_intent | status=succeeded |
| 19 | 6.2 | 4 | `invoice.updated` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 20 | 6.3 | 4 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=1 |
| 21 | 9.5 | 8 | `customer.created` | customer |  |
| 22 | 67.2 | 66 | `customer.created` | customer |  |

#### trial-once: One trial per customer and per card fingerprint

| # | arrived (s) | created (s) | event | object | state |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.7 | 0 | `customer.created` | customer |  |
| 2 | 1.9 | 1 | `setup_intent.created` | setup_intent | status=requires_payment_method |
| 3 | 2.0 | 2 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 4 | 2.0 | 2 | `invoice.finalized` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 5 | 2.1 | 1 | `customer.updated` | customer |  |
| 6 | 2.1 | 2 | `customer.subscription.created` | subscription | status=trialing |
| 7 | 2.2 | 2 | `invoice.created` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 8 | 2.3 | 2 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 9 | 2.7 | 2 | `payment_method.attached` | payment_method |  |
| 10 | 2.8 | 2 | `setup_intent.succeeded` | setup_intent | status=succeeded |
| 11 | 3.4 | 3 | `customer.subscription.deleted` | subscription | status=canceled |
| 12 | 3.8 | 4 | `customer.subscription.updated` | subscription | status=canceled |
| 13 | 4.9 | 4 | `setup_intent.created` | setup_intent | status=requires_payment_method |
| 14 | 5.0 | 5 | `invoice.finalized` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 15 | 5.1 | 5 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 16 | 5.1 | 5 | `customer.subscription.created` | subscription | status=trialing |
| 17 | 5.3 | 5 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 18 | 5.3 | 5 | `invoice.created` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 19 | 5.8 | 5 | `payment_method.attached` | payment_method |  |
| 20 | 5.9 | 5 | `setup_intent.succeeded` | setup_intent | status=succeeded |
| 21 | 6.2 | 6 | `customer.subscription.updated` | subscription | status=trialing |
| 22 | 6.7 | 6 | `customer.created` | customer |  |
| 23 | 7.8 | 7 | `setup_intent.created` | setup_intent | status=requires_payment_method |
| 24 | 7.9 | 7 | `invoice.finalized` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 25 | 7.9 | 7 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 26 | 8.0 | 7 | `customer.updated` | customer |  |
| 27 | 8.1 | 7 | `customer.subscription.created` | subscription | status=trialing |
| 28 | 8.2 | 7 | `invoice.created` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 29 | 8.2 | 7 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 30 | 9.0 | 9 | `payment_method.attached` | payment_method |  |
| 31 | 9.1 | 9 | `setup_intent.succeeded` | setup_intent | status=succeeded |
| 32 | 9.4 | 9 | `customer.subscription.updated` | subscription | status=trialing |
| 33 | 9.9 | 10 | `customer.created` | customer |  |
| 34 | 11.0 | 10 | `setup_intent.created` | setup_intent | status=requires_payment_method |
| 35 | 11.4 | 11 | `invoice.finalized` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 36 | 11.4 | 11 | `invoice.paid` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 37 | 11.4 | 10 | `customer.updated` | customer |  |
| 38 | 11.4 | 11 | `customer.subscription.created` | subscription | status=trialing |
| 39 | 11.4 | 11 | `invoice.created` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 40 | 11.4 | 11 | `invoice.payment_succeeded` | invoice | status=paid billing_reason=subscription_create attempt_count=0 |
| 41 | 11.9 | 12 | `payment_method.attached` | payment_method |  |
| 42 | 11.9 | 12 | `setup_intent.succeeded` | setup_intent | status=succeeded |
| 43 | 13.8 | 14 | `customer.subscription.updated` | subscription | status=trialing |
| 44 | 44.3 | 44 | `invoice.upcoming` | invoice | status=draft billing_reason=upcoming attempt_count=0 |
| 45 | 57.4 | 57 | `invoice.upcoming` | invoice | status=draft billing_reason=upcoming attempt_count=0 |
| 46 | 62.6 | 62 | `invoice.upcoming` | invoice | status=draft billing_reason=upcoming attempt_count=0 |

#### idempotency: Idempotency keys: replay, conflict, failure, concurrency

| # | arrived (s) | created (s) | event | object | state |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.5 | 0 | `customer.created` | customer |  |
| 2 | 2.0 | 2 | `charge.failed` | charge | status=failed amount_refunded=0 |
| 3 | 2.0 | 1 | `payment_intent.created` | payment_intent | status=requires_payment_method |
| 4 | 2.1 | 2 | `payment_intent.payment_failed` | payment_intent | status=requires_payment_method |
| 5 | 2.5 | 2 | `customer.created` | customer |  |
| 6 | 3.5 | 3 | `customer.created` | customer |  |

#### delivery-anomalies: Webhook duplicates, reordering, failure and outage

| # | arrived (s) | created (s) | event | object | state |
| ---: | ---: | ---: | --- | --- | --- |
| 1 | 0.5 | 0 | `customer.created` | customer |  |
| 2 | 1.0 | 1 | `customer.updated` | customer |  |
| 3 | 1.9 | 1 | `customer.updated` | customer |  |
| 4 | 2.6 | 1 | `customer.updated` | customer | delivery #2 |
| 5 | 3.2 | 1 | `customer.updated` | customer | delivery #3 |
| 6 | 3.8 | 0 | `customer.created` | customer | delivery #2 |
| 7 | 4.3 | 4 | `customer.updated` | customer | answered 500 |
| 8 | 49.9 | 4 | `customer.updated` | customer | delivery #2 |
| 9 | 88.1 | 50 | `customer.updated` | customer |  |
