# Webflix blueprint, milestone 2: a real subscription product

Status: approved for build on 2026-11-22. This document extends `docs/BLUEPRINT.md` (milestone 1,
which stays authoritative for everything it covers). Read that first, then `docs/FOUNDATION.md`
and `docs/BACKEND.md`. Where this document changes a milestone 1 decision, it says so explicitly.

## 1. Goal and scope

A new member signs up with Google, pays through Stripe, and manages their subscription. The
service learns from what they watch. Staff run it from an admin console. Everything a member
touches works in both deployment modes and passes the same gates as milestone 1.

| Workstream | In scope |
| --- | --- |
| Sign-in | Google and Apple through OpenID Connect; account linking; email verification; password reset; account-holder proof without a password |
| Billing | Payment-provider port; Stripe adapter; a stateful fake provider for local proof; card details tokenised in the browser; wallets as Stripe wallets on the web |
| Subscriptions | Plan and price catalogue, 7-day trial, promo codes; a state machine driven by provider webhooks; proration; failed-payment retries and grace; invoices; entitlements |
| Behaviour collection | Event taxonomy; web SDK; ingestion; an event lake in the object store; consent, retention, export and deletion |
| Recommendations | A Python pipeline: co-watch similarity, matrix factorisation, a learned ranker, re-ranking; a behaviour simulator; offline evaluation; hybrid serving |
| Experimentation | Flags, deterministic assignment, exposure logging, analysis |
| Email | Sender port, templates, a local mailbox |
| Admin console | Staff sign-in through Keycloak; member support actions; plans and prices; editorial rows; experiments; audit log |

Not in this milestone: mobile and TV apps, DRM, per-title encoding, downloads, the content ingest
studio, a real Cloudflare deployment, passkeys (the design leaves room for them), an online
ranking service (batch scoring only).

Defaults the owner approved: Keycloak for staff, optional for consumers on Kubernetes; keep the
three plans and add a 7-day trial; build Google sign-in against the development issuer and wire a
real Google client when one is supplied. Stripe needs nothing from the owner: a temporary Stripe
sandbox created with the Stripe CLI supplies working test keys (§5.5), so the Stripe adapter is
proven against real Stripe in this milestone, not later.

## 2. Principles that constrain every design below

1. **The member-facing request path stays portable.** `packages/contracts`, `core`, `http` use
   Web-standard APIs only and run on Node and on Workers. New capabilities arrive as ports with
   adapters, exactly as in milestone 1.
2. **Operational backends may differ by mode.** Keycloak, Python batch jobs and the local mailbox
   run on Kubernetes (or on a developer machine). Cloudflare mode uses a configured equivalent or
   reads their output from R2, KV and D1. Each such difference is listed in §9, not improvised.
3. **Money is never decided by the client or by our own optimistic writes.** The payment provider
   is the source of truth; Webflix stores a projection that changes only on verified provider
   events or on reconciliation.
4. **Card data never reaches Webflix servers.** No route accepts a card number, expiry or security
   code. This removes the milestone 1 `payment` request bodies (a breaking contract change, §5.6).
5. **Identity stays first-party by default.** Webflix is an OpenID Connect relying party; Google,
   Apple and Keycloak are configured issuers. Profiles, PINs, parental controls, device sessions
   and stream limits remain Webflix concepts.
6. **Behaviour data is collected for a stated purpose, with consent where required, and never used
   to profile a kids profile.**
7. **Everything is provable locally.** Each external system has a faithful local stand-in that the
   conformance and browser suites drive: a development OpenID issuer, a stateful fake payment
   provider with a test clock, a local mailbox, a behaviour simulator.
8. **The D1 rules still hold**: no interactive transactions, at most 100 bound parameters per
   statement, warm browse at most 2 database round trips.

## 3. New ports (in `packages/core/src/ports`)

Each port gets an in-memory implementation in `@webflix/core/memory` and a contract suite in
`@webflix/core/testing`, as in milestone 1.

| Port | Responsibility | dev | k8s | cloudflare |
| --- | --- | --- | --- | --- |
| `IdentityProvider` | OpenID Connect relying party: authorisation URL, code exchange, ID token validation, JWKS caching | generic OIDC adapter against the development issuer | same adapter; Google, Apple, Keycloak by configuration | same adapter |
| `PaymentProvider` | Customers, subscriptions, payment methods, previews, refunds, invoices, webhook parsing, reconciliation, catalogue sync | fake provider | Stripe or fake by configuration | Stripe or fake by configuration |
| `EmailSender` | Send a rendered message with an idempotency key | in-memory outbox with a mailbox API | SMTP (Mailpit on kind) or an HTTP provider | HTTP provider; outbox in D1 for local |
| `EventSink` | Durable append of validated event batches | lake writer on the filesystem blob store | lake writer on S3 | lake writer on R2 |
| `RecommendationStore` | Read precomputed neighbours and per-profile candidates; write by the importer | SQLite | PostgreSQL | KV for per-profile lists, D1 for neighbours |
| `Experiments` | Read experiment definitions; deterministic assignment | database | database | database with KV cache |
| `StaffVerifier` | Validate a staff access token (issuer, audience, signature, expiry) and map roles | development issuer | Keycloak | configured issuer |

`PaymentProvider` is provider-neutral. Amounts are integers in minor units with an ISO currency.
Every mutating call takes an idempotency key derived from a Webflix operation id.

## 4. Sign-in

### 4.1 Federation
- Flow: `GET /auth/oidc/{provider}/start` redirects to the issuer with `state`, `nonce` and PKCE.
  The transaction state lives in a short-lived encrypted `__Host-` cookie, so no server storage is
  needed. `GET` or `POST /auth/oidc/{provider}/callback` (Apple posts a form) validates the
  response, then signs the member in, links, or continues sign-up.
- Providers are configuration: issuer, client id, client secret or signing key, scopes, display
  name. Apple's client secret is a signed token generated with Web Crypto.
- `account_identities (account_id, provider, subject, email_at_link, created_at)`, unique on
  `(provider, subject)`. `accounts.password_hash` becomes nullable.
- Linking rule: an existing account is linked automatically only when the issuer asserts a
  verified email and the Webflix account's email is verified. Otherwise the member must sign in to
  the existing account first, then link from Account. No silent takeover by email match.
- A member can unlink a provider only while another way to sign in remains.

Facts about the real providers that the relying party must handle (established while building
the development issuer; `packages/dev-idp/README.md` has the full list and the fault catalogue):
- Apple signs ID tokens with RS256. ES256 is what the relying party uses to sign Apple's client
  secret.
- Apple answers with a cross-site form post, so the transaction cookie for a form-post provider
  must be `SameSite=None; Secure`. The development issuer is same-site and would hide this.
- Apple's `user` field is unsigned: use it for the display name only, never for identity or email.
  Apple sends `email_verified` as a string.
- Google's and Apple's access tokens are opaque; only the ID token is validated.
- Every negative case in the development issuer's fault catalogue (29 named faults: signature,
  claims, identity, token response, authorisation response, endpoint) must be rejected by the
  relying party, proven by tests that inject each one.
- Paths the development issuer assumes, now fixed: callbacks at
  `/api/v1/auth/oidc/{provider}/callback`; the staff console's callback at `/admin/auth/callback`;
  the staff client is `webflix-admin` and the admin API's audience is `webflix-admin-api`, with
  roles read from `resource_access["webflix-admin"].roles`. The Keycloak realm import must match.

### 4.2 Account-holder proof
Milestone 1's privilege model asks for "the account password". Accounts created through Google
have none. The proof becomes: the password, **or** a fresh sign-in with a linked provider
(`max_age=0`), either of which sets `sessions.elevated_until` for 5 minutes. `credentials.ts`
stays the only place that grants it, still metered by the `profile-pin` budget, and the
enumerating call-site test is extended. The web's password prompts become "Confirm it's you".
The fresh sign-in is judged by the ID token's `auth_time`; a provider that omits it (Google's
discovery document does not promise it) fails closed, and the member is offered the password or
another linked provider instead. Establish what each real provider returns before promising a
password-free proof for it.

### 4.3 Email verification and password reset
- Single-use tokens, stored hashed, 30 minutes for reset and 24 hours for verification.
- Responses never reveal whether an email has an account. Both flows are rate limited per address
  and per email.
- A completed reset signs out every other device and sends an alert email.
- Sign-up no longer needs a verified email to start a trial, but an unverified account is
  reminded, and automatic linking (§4.1) depends on verification.

### 4.4 Development issuer
`packages/dev-idp`: a small standards-compliant OpenID issuer in TypeScript on Web Crypto
(discovery, authorise with an account picker page, token, JWKS, userinfo), mounted under
`/dev-idp/*` only when `WEBFLIX_ENV` is not production. It stands in for Google and Apple in every
local mode and for the staff issuer where Keycloak is absent. It ships test personas: a new Google
user, a Google user whose email matches an existing account (verified and unverified), a staff
member for each role.

Built: `createWebflixDevIdp` mounts `/dev-idp/google`, `/dev-idp/apple` and `/dev-idp/staff`. It
has no runtime dependencies and runs on Node and in the Workers runtime. Its state is sealed
tokens plus a two-operation store (`claim`, `has`) for single use and revocation; the in-memory
default is strict within one process only. Still to do by the runtime owners: mount it in
`apps/api` and `apps/edge` when the environment is not production, give replicas and isolates a
shared `WEBFLIX_DEV_IDP_SECRET`, back the store with the rate limiter's infrastructure (a Durable
Object, Valkey, or a table) where several instances serve one deployment, proxy `/dev-idp` in the
Vite dev server, and exempt its pages from the API's response-header middleware.

## 5. Billing and subscriptions

### 5.1 Sign-up changes shape (breaking change to milestone 1)
The account is created **before** payment, as an account without membership:
1. Email (or Google) creates the account and a session. Membership status is `none`.
2. Plan choice.
3. Payment: the browser confirms with the provider's own form; Webflix receives only a provider
   token or a confirmation result.
4. A provider event activates the membership. The web waits on `GET /account` and shows a
   designed "confirming your payment" state, including for a 3-D Secure challenge.
5. Profiles.
An account that stops before step 4 can sign in and resumes at the right step.

### 5.2 Projection and state machine
| State | Entitled to play | Entered when |
| --- | --- | --- |
| `none` | no | account exists, never subscribed |
| `incomplete` | no | first payment awaits confirmation |
| `trialing` | yes | subscription started with a trial |
| `active` | yes | paid |
| `past_due` | yes, during grace | a renewal attempt failed, whether or not the provider will retry |
| `suspended` | no | grace expired without payment, or the provider marked the subscription unpaid or paused |
| `canceled` | no | the subscription has ended |

"Cancelling" is not a state: a subscription the member has asked to end stays `trialing`, `active`
or `past_due` with `cancel_at_period_end` set, and is entitled until the period ends. Only then is
it `canceled`. A first payment that is never confirmed expires at the provider and returns the
account to `none`. `suspended` carries a reason (grace expired, unpaid, paused).

Grace starts at the first failed renewal attempt, which Webflix stores (the provider has no such
field), and suspension is computed from time, not from provider status. The window is
configuration (`WEBFLIX_BILLING_GRACE_SEC`, default 7 days). Stripe's default retry window is
about two weeks, so Webflix may suspend while Stripe is still retrying; a payment that then
succeeds restores `active`. When the provider's retries run out, what happens depends on a
provider account setting: with "mark unpaid" the same subscription recovers when the member pays;
with "cancel" (Stripe's implied default) recovery is a new subscription through the restart flow,
without a second trial. The projection and the web handle both; "mark unpaid" is the recommended
production setting.

Entitlement is one function of state, period end, grace and plan features; playback, browse gates
and the account page all call it. `docs/STRIPE.md` §9 has the full mapping from Stripe's states.

### 5.3 Provider events
- `POST /webhooks/payments/{provider}`: verify the signature over the raw body with Web Crypto,
  record the event id (`provider_events`, unique), enqueue, answer 2xx. Processing is a job: at
  least once, idempotent by event id, retried, dead-lettered.
- Processing never trusts event order or event contents: it always retrieves the current
  subscription and its latest invoice from the provider and writes the projection in one batch
  with a version guard. Against a real Stripe sandbox, 83 of 319 deliveries arrived out of order
  (a paid event before the created event of the same invoice on every sign-up), and timestamps
  have one-second resolution, so applying an event's own object is not safe.
- Queue payloads carry event ids and Webflix data only, never provider library objects (they do
  not survive structured cloning).
- A scheduled reconciliation walks subscriptions that changed recently or look stale, and repairs
  the projection. It is also the recovery path after an outage.
- `billing_operations (id, account_id, kind, attempt, idempotency_key, status, provider_ref)` makes
  every money-moving request safe to retry. The idempotency key is derived from the operation id
  and the attempt number, because a declined charge is replayed under its key: a new attempt
  after the member changes card needs a new key. Provider events echo the key of the call that
  caused them, which links each event to its operation. This closes the "commit outcome unknown"
  case from milestone 1 for charges.

### 5.4 Catalogue, trials, promotions, tax
- Plans and prices live in Webflix (admin-managed, per currency) and are synchronised to the
  provider by lookup key, idempotently. Plan features (screens, quality) stay Webflix data.
- Trial: 7 days, payment method required up front, one trial per account and per card
  fingerprint. **Webflix enforces both**; Stripe enforces neither (it granted a second trial to
  the same customer). That makes payment a two-step flow: the browser confirms the card first (a
  setup confirmation), the server reads the confirmed method's fingerprint and checks
  `trial_fingerprints`, then creates the subscription with a trial or, if the member is not
  eligible, as a paid subscription whose first payment the browser confirms. Wallets may present
  a tokenised card number, so the fingerprint rule is best effort for wallets. Use the provider's
  trial-period parameter (verified); Stripe's newer trial offers are not verified here.
- The "trial ending" email is scheduled from the trial's end time, 3 days before. The provider's
  own trial-ending event is a hint only (it arrived for 1 of 11 short trials).
- Promo codes map to provider promotion codes. The port has `validatePromotionCode`, which reads
  the code before applying it, because the provider refuses exhausted and expired codes without
  saying which. The fake provider supports percentage and fixed-amount codes with expiry and
  redemption limits.
- Tax is a provider setting, off in the fake provider and **not verified** against the sandbox
  (its key is refused by the tax endpoints). Keep it off in the sandbox lane. Prices display as the
  provider computes them; Webflix never computes tax.
- Changing the card does not make the provider attempt an open invoice: after a card change on a
  `past_due` subscription, Webflix asks the provider to pay the invoice explicitly.

### 5.5 Two providers, both proven
The port has two implementations, and the same checks run against both: the `PaymentProvider`
contract suite and the billing journeys of the conformance and browser suites. Running the same
checks on both is what keeps the fake honest.

**Stripe sandbox (the real integration).** `packages/adapters-stripe` is fetch-based and portable.
It is proven against a real Stripe sandbox:
`docs/STRIPE.md` is the reference for this lane: it records what was observed against a real
sandbox on 2026-11-22 (11 scenarios, 147 API calls, 323 verified webhook deliveries), the
recommended API shapes, the event sequences and the recorded fixtures in `tools/stripe/fixtures`
that the adapter's unit tests use.
- Provisioning is built (`tools/stripe`, `make stripe-sandbox`): the pinned CLI provisions a
  sandbox with no login in about two seconds. It expires after 7 days unless claimed, which needs
  the owner's Stripe account and is the owner's decision. Treat the sandbox as disposable:
  catalogue sync (§5.4) rebuilds products and prices in a fresh one by lookup key.
- The sandbox's key is a **restricted** key. It cannot create test clocks, customer sessions, tax
  calculations or meters. A full test key (the owner claims the sandbox, or supplies their own
  test keys through `make stripe-use-key`) lifts those limits.
- So the lane has two parts:
  - **Real time**, on the anonymous sandbox: sign-up with and without a trial, each decline, plan
    changes checked against the proration preview, cancel, resume, refunds, promo codes,
    idempotency, and renewal, failure and recovery using trials of some tens of seconds followed by
    an explicit request to pay the invoice (standing in for the provider's own off-session
    attempt).
  - **Test clocks**, only with a full key: the provider's own retry schedule, retries running out,
    expiry of an unconfirmed first payment, mid-period proration, renewal against its preview.
    Without a full key these checks skip with that reason. A clock holds at most three customers
    and only moves forward, so each check creates its own.
- The CLI is a pinned dev dependency of `tools/stripe`, never a global install. Isolating it from
  the owner's home directory needs a private configuration home, a non-default project name and
  the update check disabled; the tooling does all three, and the CLI's output is always captured
  and filtered because it prints the secret key.
- Test keys are credentials: they live only in git-ignored files with owner-only permissions, are
  never printed in logs or reports, and are never committed.
- Webhooks reach a local mode through the CLI's listener, run as a managed sidecar by the make
  targets. It neither retries a failed delivery nor replays what was missed during an outage, so
  in local modes recovery after an outage is the reconciliation job's work, by design.
- Server-side checks use the provider's test payment-method ids. A challenge can only be completed
  in a browser, and card numbers can only be sent through the provider's own script, so the
  challenge journey belongs to the browser suite. Wallets render in the payment form but cannot be
  exercised without real devices; say so in the results.
- Do not depend on saved cards in the payment form (refused for the sandbox key).
- The security headers of both modes allow Stripe's script, frame and connect origins only when
  Stripe is the configured provider.

**Fake provider (`packages/payments-fake`, the hermetic lane).** Stripe's official mock is
stateless, and a real sandbox needs the network, has rate limits and caps customers per clock.
Suites that run on every change, in parallel, three times over, need a provider with none of
those limits. The fake is deliberately small: the port's stateful implementation, nothing Stripe
does not also do.
- Test payment tokens for success, each decline reason and a required challenge.
- A payment form served from its own path (`/_pay/*`), so card data in local modes goes to the
  simulator and never to the API.
- A test clock on the non-production control surface: advancing it renews, retries, fails and
  expires subscriptions and emits signed webhooks, with the same event semantics the Stripe
  adapter normalises to.
- State in the database through its own tables, so it works on every dialect and survives
  restarts.

Which lane runs where: every suite run uses the fake; the gate also runs the contract suite and
the billing journeys once per mode against the Stripe sandbox. A Stripe-lane check that cannot
reach Stripe skips with that reason; it never passes silently.

### 5.6 Contract changes
- Removed: every request field carrying card data (`payment` on sign-up and plan change; the
  payment-method update route itself). A contract test fails if any route schema contains a card
  number, expiry or security-code field; the bodies are strict, so a card sent anyway is refused.
- `subscription` and `plan` on the session and `GET /account` are null without a membership.
- Added: checkout start and status, payment-method setup, invoices, promo validation, webhook
  endpoints, provider configuration for the web (`GET /billing/config`: publishable key or
  simulator URL), trial information on plans.
- `Account` gains `membership.status` from §5.2 and `entitlement`.

## 6. Behaviour collection

### 6.1 Events
Typed in `packages/contracts/src/events.ts`, versioned, validated at ingestion.
Envelope: `eventId` (UUIDv7), `type`, `occurredAt` (client clock), `receivedAt` (server), `deviceId`
(anonymous, client-generated), `sessionSeq`, `app` (platform, version), `context` (surface, row id,
rank, experiment assignments), `payload`. The server adds account, profile, plan and country from
the session; client-supplied identities are ignored.

Client events: impression (a card visible for at least 1 s; sampled), row view, title open,
preview start and complete, search query and click, list and rating changes, sign-up steps,
client errors. Server events (more trustworthy, emitted by services): playback start, progress,
complete and abandon; billing transitions; sign-in and sign-up outcomes; experiment exposure when a
server-side treatment is applied.

The recommendation pipeline is built and was run end to end against simulated events, so the
schema it needed is written down: `services/recs/schemas/event.schema.json`, with the fifteen
decisions this section left open listed in `services/recs/README.md`. The contracts author adopts
that schema or corrects it, then exports JSON Schema from contracts as the single source; the
pipeline reads it through one module. The decisions that matter most to other owners:
- Server-added fields live in one `subject` block (pseudonymous account and profile keys, plan,
  country, `restricted`, a consent stamp), stamped at receipt.
- A `consent.change` server event exists. Consent is per account and the latest stamp wins;
  without the event, a member who withdraws consent and never returns would stay in training data.
- Position matters: `context.rowRank` and `context.rank` (both 1-based) are sent on impressions
  **and on the title-open that follows**, because the ranker's position-bias correction credits an
  impression only when that exact card was opened.
- `context.policy { id, explore }`: a small share of sessions (5 % in the simulator) shows rows
  and items in random order and says so. The ranking policy must keep such an exploration slice,
  or position bias cannot be estimated from real traffic.
- `search.query` carries no query text. A sign-in event carries no profile.
- The lake is partitioned by receipt hour. Schemas are closed; a new field is a new version of the
  event type.

### 6.2 Path
`POST /events` (batch of at most 50 events and 64 KiB; anonymous allowed; rate limited per device
and per account) validates, enriches, and publishes to the job queue. A consumer buffers and
writes compressed newline-delimited JSON objects to the blob store:
`events/dt=YYYY-MM-DD/hh=HH/{uuid}.ndjson.gz` (private prefix, never served). This **event lake**
is the canonical store in every mode. Delivery is at least once; consumers of the lake deduplicate
by `eventId`. A Python job compacts each closed hour into Parquet.

There is no ClickHouse in this milestone. Analytics and experiment metrics are computed by batch
jobs over the lake and written back as aggregates the admin console reads.

### 6.3 Privacy
- `consents (subject, purpose, granted, source, at)`; purposes `analytics` and `personalisation`.
  Mode by configuration: opt-in, opt-out or off. The web shows a consent control where required
  and honours Global Privacy Control.
- Kids profiles: only server playback events needed to operate the service; flagged
  `restricted`, excluded from training, analytics and experiments.
- Events carry a pseudonymous subject (keyed hash of the account id). Account deletion deletes the
  key mapping and the subject's rows at the next compaction.
- Member rights: "Download your data" (asynchronous export to a signed link by email) and "Delete
  account" (account-holder proof, cooling-off period, then erasure; billing records retained as
  law requires and stated).
- Retention: raw events 13 months, aggregates 37 months, both configurable.

## 7. Recommendations

### 7.1 Pipeline (`services/recs`, Python, managed with uv)
Commands: `simulate`, `build-dataset`, `train`, `evaluate`, `score`, `publish`, `analyse-experiments`.
- Dataset: implicit feedback strength from watch fraction, completion, rating and list actions,
  with time decay; restricted subjects excluded.
- Models: item-to-item co-watch similarity with shrinkage; implicit matrix factorisation for
  personal candidate scores; content vectors from metadata and synopsis for cold-start titles; a
  gradient-boosted ranker trained on impressions and plays; re-ranking for diversity, freshness and
  repetition.
- Evaluation: temporal split; recall, NDCG, coverage, diversity and novelty at K; baselines are
  popularity and the milestone 1 rule engine. A run that does not beat the rule engine on the
  simulator is not published.
- Output: versioned artefacts in the blob store (`recs/v={run}/…` Parquet shards and a manifest)
  and a pointer `recs/current.json`. Nothing in the request path reads Parquet.

Built and measured (`docs/RECOMMENDATIONS-ML.md`; `make recs` runs it from an empty directory in
about 15 minutes at full simulated scale: 39.6 million events, 135,679 profiles, peak memory
9.7 GB). On the simulator the learned system beats the real rule engine on the publish gate:
utility of the first ten recommendations 0.787 against 0.675, a paired difference of +0.112 with a
95 % interval of [0.109, 0.115]. These are simulator results: they prove the pipeline and the
relative ordering under the simulator's assumptions, not real-world lift, which only the online
experiment can measure. Facts the serving and platform owners build on:
- The publish gate is utility against the rule engine where simulator truth exists, and
  search-discovery NDCG on real data (replay on logged plays rewards whatever the incumbent
  showed). It is keyed on a hash of code and parameters.
- The ranker is pointwise gradient boosting from scikit-learn: the usual learning-to-rank
  libraries need a system OpenMP on macOS, which this project does not install.
- Artefacts: a pointer `recs/current.json` written last; a per-run manifest with a checksum for
  every file; a neighbours table (at most 40 per title) and a profiles table (one row per
  profile: rows `personal`, `top-picks`, `billboard`, `because-you-watched`, and `expiresAt`),
  keyed by the pseudonymous profile key. `services/recs/README.md` specifies them for the
  importer, including batch sizes that respect the 100-parameter limit.
- The request path needs the pseudonym key to derive a profile's key, and falls back to the rule
  engine after `expiresAt`.
- Jobs: an hourly compaction and a daily pipeline run. The rule-engine baseline is produced by a
  Node script that imports `@webflix/core`, so that step needs an image with the repository's
  packages; the Python image has no Node.
- Memory is dominated by holding the dataset in memory; shard it per profile before a much larger
  catalogue or member base.

### 7.2 Serving (TypeScript)
- An importer job reads the current artefacts and fills the `RecommendationStore`: item
  neighbours, and per-profile candidate lists with scores and the model version.
- `engine.ts` remains the authority for page assembly and every rule (maturity, entitlement,
  dislikes, badge caps, deduplication). It takes candidates and scores from the store when a
  fresh list exists for the profile, and falls back to the milestone 1 rules otherwise (new
  profile, stale model, restricted profile). The fallback is not an error path; it is cold start.
- Session re-ranking in the request path: what was just watched boosts its neighbours immediately,
  using the neighbours table, without waiting for a batch.
- Warm browse stays within 2 database round trips; per-profile lists are one read.

### 7.3 Simulator and data
The simulator generates members with latent tastes, position bias, time budgets and churn, and can
drive the real ingestion endpoint so the whole path is exercised. A public ratings dataset may be
used for offline algorithm validation only (downloaded at run time, never shipped; its licence is
recorded in `docs/CREDITS.md`).

## 8. Experimentation, email, admin

### 8.1 Experimentation
- Definitions in the database: key, variants and weights, targeting (percentage, plan, country,
  new or existing), layer for mutual exclusion, status, dates.
- Assignment is deterministic: hash of unit id, experiment key and salt. The unit is the profile,
  or the device before sign-in. `GET /session` returns the caller's assignments.
- Exposure is logged when the treatment is experienced, not when assigned.
- Analysis job: sample-ratio check, per-variant metrics with intervals, a guard against peeking.
  An A/A test must come out flat before any result is trusted. First real experiment: rule engine
  versus learned recommendations.

### 8.2 Email (`packages/email`)
Typed templates rendering HTML and text: verify email, reset password, welcome, receipt, payment
failed, trial ending, plan changed, cancellation, new sign-in, security change. Sending is a job
with an idempotency key; a suppression list honours bounces. Local modes expose a mailbox API on
the non-production diagnostics surface for the test suites.

### 8.3 Admin console (`apps/admin`, API under `/api/admin/v1`)
- Staff authenticate with the staff issuer (authorisation code with PKCE in the console) and call
  the admin API with a bearer token. Staff identity never becomes a member session.
- Roles: `support`, `billing`, `content`, `experiments`, `admin`. Routes declare the role they need
  (`auth: "staff"` with a role), enforced by the guard.
- Every mutating action writes `audit_log` (actor, action, target, before, after, reason, request
  id) in the same batch as the change.
- Capabilities: member lookup and support actions (sign out everywhere, send reset, remove a PIN
  with a reason); billing actions (refund, cancel, extend trial, complimentary period); plans and
  prices with provider sync; editorial control (billboard, curated collections, availability);
  experiments and results; system health (dependencies, queue depth, dead letters with replay).
- Keycloak ships in the chart as an optional component with an imported realm (console client,
  roles, demo staff). It may also be configured as a consumer issuer on Kubernetes.

## 9. Mode mapping

| Capability | dev | k8s | cloudflare |
| --- | --- | --- | --- |
| Consumer sign-in issuers | development issuer | Google, Apple, optional Keycloak; development issuer on kind | Google, Apple; development issuer locally |
| Staff issuer | development issuer | Keycloak | configured issuer; development issuer locally |
| Payment provider | fake; Stripe sandbox lane | fake on kind; Stripe sandbox lane; Stripe by configuration | fake locally; Stripe sandbox lane; Stripe by configuration |
| Webhook processing | in-process queue | Valkey Streams worker | Queues consumer |
| Email | in-memory mailbox | Mailpit on kind; SMTP or HTTP provider | HTTP provider; D1 outbox locally |
| Event lake | filesystem blob store | S3-compatible store | R2 |
| Batch jobs (compaction, training, scoring, analysis) | `make recs` on the developer machine | CronJobs running the `webflix-recs` image | run outside Workers against R2 (a container or any scheduler); locally the ops script syncs events out and artefacts in |
| Recommendation store | SQLite | PostgreSQL | KV and D1 |
| Admin console | Vite | web image, `/admin` | static assets, `/admin` |

To verify before relying on them (each owner checks current platform documentation, not memory):
whether Cloudflare Containers suit the scheduled batch jobs; which HTTP email providers or
Cloudflare email bindings are appropriate; KV bulk-write limits for per-profile lists.

## 10. Repository additions and ownership

| Path | Contents |
| --- | --- |
| `packages/dev-idp` | development OpenID issuer |
| `packages/payments-fake` | stateful fake payment provider, payment form, test clock |
| `packages/adapters-stripe` | Stripe adapter (portable) |
| `packages/email` | templates and rendering; HTTP sender adapters |
| `packages/telemetry` | web event SDK |
| `apps/admin` | staff console |
| `services/recs` | Python pipeline, simulator, analysis |
| `packages/contracts`, `core`, `db`, `http` | new routes, events, ports, services, migrations, handlers split by area |

Handlers and services are split into one module per area (`identity`, `billing`, `events`,
`personalisation`, `experiments`, `admin`) so that engineers working in parallel do not share files.

## 11. Sequence

1. **Foundation.** Contracts (routes, events, error codes), ports with in-memory implementations
   and contract suites, migrations for all three dialects, the area module skeleton and
   composition wiring. No service logic. The foundation is additive: milestone 1 keeps working
   and every gate stays green when it lands. The card-data fields of §5.6 were therefore not
   removed here; the contract test that forbids them arrived with an explicit list of the legacy
   fields still allowed. Done with the web checkout (2026-11-23): the list is empty, sign-up and
   plan-change bodies are strict (a card is refused with `validation_failed`),
   `PUT /account/payment-method` is removed, and `subscription`/`plan` are null on the session
   and the account when there is no membership.
2. **Parallel build.** Identity, email and the development issuer; billing, the fake provider and
   the Stripe adapter; events, lake and privacy; the Python pipeline; experimentation and
   recommendation serving; admin API. Platform work for Kubernetes and Cloudflare starts as soon
   as the ports are stable.
3. **Adoption.** Web sign-in, checkout and account pages; consent and instrumentation;
   personalised rows; the admin console.
4. **Verification.** Conformance checks and browser specs for every journey in §12; independent
   reviews of sign-in and billing security, of privacy, and of the pipeline's correctness; fix
   rounds; documentation.

The parallel-work rules of `docs/BLUEPRINT.md` §11 apply unchanged, including the machine rules:
only `webflix*` clusters and containers, the repository kubeconfig, processes stopped by PID.

## 12. Done means

- **Journeys pass in both modes**, driven by the suites:
  - sign up with Google, pay, watch, cancel, resubscribe;
  - a card that needs a challenge; a declined card; a promo code; a trial that converts and one
    that is cancelled;
  - a renewal fails, is retried, enters grace, then suspends; payment recovers and playback
    returns;
  - plan upgrade and downgrade with the previewed proration;
  - webhooks delivered twice, out of order, and after an outage, leave the projection correct;
  - verify email; reset a password; link and unlink Google; confirm identity without a password;
  - a staff refund, a removed PIN and a curated row, each with an audit entry; a staff member
    without the role is refused.
- **Real Stripe**: the payment-provider contract suite and the real-time billing journeys of §5.5
  (success, a challenge in the browser, each decline, a renewal that fails and recovers, plan
  changes, a refund) pass against a Stripe sandbox at least once in each mode, with webhooks
  delivered by Stripe. The test-clock journeys pass when a full test key is available and are
  reported as skipped, with the reason, when it is not.
- **No card data on Webflix servers**: enforced by the contract test of §5.6 and by a browser
  check that card fields only ever post to the provider's origin.
- **Recommendations**: the learned model beats the rule engine offline on the simulator; the
  experiment pipeline detects that difference and reports an A/A test as flat; a restricted
  profile is never in training data.
- **Privacy**: consent modes behave as configured; export and deletion complete; a kids profile
  produces no behavioural events.
- **Security**: independent review with no open high-severity finding.
- **Gates**: lint, typecheck and tests; the conformance suite and the browser suite pass three
  times running in each mode.

## 13. Status (2026-11-23)

What §12 asks for, against what was run. "Run by the committer" means the session that integrated the
work ran it itself on the committed code; everything else names who ran it. The suites: the
conformance suite (`tools/smoke`, 152 black-box checks) and the browser suite (`e2e`, 282 tests over
Chromium, Firefox, WebKit and the staff console).

| Mode | Conformance | Browser suite |
| --- | --- | --- |
| dev (Node, SQLite, built app) | 147 passed, 0 failed, 5 skipped (twice on one database) | 274 passed, 0 failed, 8 skipped, on Chromium, Firefox and WebKit |
| Cloudflare (local Worker, D1, KV, R2, cron and lake jobs loops) | 149 passed, 0 failed, 3 skipped | 274 passed, 0 failed, 8 skipped, on Chromium, Firefox and WebKit |
| Kubernetes (kind, one node, conformance variant: PostgreSQL, Valkey, Garage, two replicas of each tier) | 148 passed, 0 failed, 4 skipped | 274 passed, 0 failed, 8 skipped, on Chromium, Firefox and WebKit |

All run by the committer, once per mode. The dev and Kubernetes runs were on the final code. The
Cloudflare run came before the last changes: the duplicate-heartbeat fix (found by that run), and
the browser specs and the one conformance check changed during the Kubernetes run. The Worker's own
tests (298, with the duplicate-heartbeat case) pass on the final code; the two suites were not rerun
on it. Every skip names its reason; they are conditions of the target (relaxed rate limits, every
title packaged, probes not routed, a setting a spec needs that the variant does not have), not
failures waived.

**Journeys pass in both modes: met, with the fake payment provider.** Every journey of §12 has a
conformance check and a browser spec, and they pass in all three modes above. The journeys that
involve money run against `packages/payments-fake`, not Stripe.

**Real Stripe: not met.** On 2026-11-21 and 22 a proof run of eleven scenarios, the adapter's
contract suite in Node and in workerd, and seven of eight real-time journeys in dev with webhooks
delivered by Stripe all passed against a Stripe sandbox (`docs/STRIPE.md`). Then the claimable
sandbox key's own, lower rate limit began answering 429 to every request, and it still did on
2026-11-23. Never run against Stripe: the outage journey, the Worker and the cluster through the
HTTP webhook route, and everything billing gained since (rate limits, the first-invoice preview,
credit and discount amounts, erasure of the customer). The sandbox expires on 2026-11-28; claiming
it, which lifts the limit, is the owner's decision.

**No card data on Webflix servers: met.** Request bodies are strict and a card is refused without
being echoed (contract test, conformance check `identity.signup.card-data-refused`); browser specs
assert card fields only ever post to the provider's origin.

**Recommendations: met offline, with a caveat online.** Under the gate as it now stands (the home
page members see, at three weekly cutoffs) the learned page beats the rule engine's in 9 of 9 seed
and cutoff cells at medium size and at all three cutoffs at full size; at smoke size no interval
clears zero and the gate refuses. Served to one arm in the simulator, the model raises plays by 3
to 4% in its first week and is within noise over two weeks without a daily refresh; the product's
own analysis would detect that first-week effect reliably only at full-size traffic. An A/A test
reads flat. A restricted, erased or deleted profile is excluded from datasets, scoring and import.
Numbers with their spread: `docs/RECOMMENDATIONS-ML.md`. Production serves the rule engine until an
operator turns the learned policy on.

**Privacy: met for opt-in, the default.** Opt-in is proven by the suites in every mode; opt-out by
browser specs on an opt-out dev API; `off` was not run live in any mode. Export and deletion complete in every
mode (inline in dev, through the scheduled lake jobs elsewhere). A kids or restricted profile
produces no behavioural events. Retention is enforced by `webflix-recs retain` and the product's
own sweep.

**Security: met.** The independent review found one high-severity defect, an account takeover
through automatic linking, which is fixed and held by the conformance check
`identity.oidc.prehijack`. No high finding is open. The independent privacy, pipeline and UX reviews
and what was done about each finding are recorded in the commit of 2026-11-23 "Fix what four
independent reviews found".

**Gates: met once, not three times.** Lint, typecheck and tests pass. The suites passed once per
mode by the committer, not the three consecutive runs §12 asks for: the owner judged the full gate
more than a spike needs.

### Known gaps

- Nothing has been deployed to a real Cloudflare account, and no real Google or Apple client has
  been used. The staff console's sign-in through Keycloak was proven once in a headless browser on
  the production configuration of the local cluster.
- Restarting a membership does not use the card on file, and an account without a trial makes two
  trips to the provider's page.
- A staff member with only the Billing role cannot open a member's page, so cannot reach Refund.
- Staff tokens are validated offline and cannot be revoked within their five-minute life, and the
  staff API has no rate limit.
- Two confirmations of one checkout at the same instant can disagree about trial eligibility, and
  a process that dies between writing a membership and its follow-up steps loses that change's
  event and emails.
- Restoring a database backup brings back accounts erased after the backup; nothing that survives
  the restore names them (`docs/KUBERNETES.md` §5, `docs/CLOUDFLARE.md` §8).
- After keeping an account that was scheduled for deletion, the "if you resume" amount is the
  plan's list price; the server has no "if resumed" figure.
- Email dates are UTC calendar dates and can differ by a day from what the app shows.
- On Kubernetes, password and PIN hashing is the capacity limit (about seven checks per second per
  CPU); the hashing queue has no bound. The three-node failure scripts and key rotation were not
  rerun in this milestone.
- Garage, the cluster's object store, ignores conditional writes (lake jobs are serialised by the
  schedule) and its lifecycle rules are unproven.
- The pseudonym key cannot be rotated.
- A hover preview can cover the consent prompt; titles repeat near the top of the personalised
  home page.
- The Vite dev server can abort on Node 26.8.1 (a V8 fault); the suites run against the built app.
