# Webflix — Contract changes

Append-only log of changes to `@webflix/contracts` made after the foundation, so the web
engineers coding against the contract can see what moved. Newest last. Each entry: date, what
changed, whether it is breaking, and what clients should do.

---

## 2026-11-21 — backend implementation (no changes)

The whole API (43 routes) was implemented against the foundation contract as it stands: no
schema, route, error code or constant was added, changed or removed. Behaviour worth knowing
that the contract leaves to the server is documented in `docs/BACKEND.md` §3 (browse batching,
playback heartbeats and revocation, rate limits in dev, mock cards).

## 2026-11-21 — backend follow-ups (all additive; no client has to change)

Every change below is additive: no route, field, code or constant was renamed or removed, and a
client built against the previous contract keeps working against the new server (and the new
client against an old server, apart from the new routes themselves). Reasons and trade-offs are
in `docs/DECISIONS.md` D15–D23.

**Routes (46, was 43)**

- `PUT /account/payment-method` (`updatePaymentMethod`, account): body `UpdatePaymentMethodBody`
  `{ payment: MockCardPayment }`, answers `AccountDetails`; `payment_declined` (with
  `declineReason`) exactly like sign-up, nothing stored on decline; rate limit `payment`. Use it
  instead of re-submitting `PUT /account/subscription` with the same plan and a new card.
- `GET /showcase` (`getShowcase`, public): `Showcase { items: ShowcaseTitle[] }`, at most
  `SHOWCASE_SIZE` (40) titles rated at most `SHOWCASE_MATURITY_CEILING` (13+), each `{ id,
  name, type, images: { card, poster, logo, backdrop } }` with versioned URLs. Cacheable
  (`Cache-Control: public`, ETag, 304). For signed-out screens; never build `/cdn` URLs by hand.
- `GET /titles/:id/popularity` (`getTitlePopularity`, account): `TitlePopularity { titleId,
  days: TitlePopularityDay[] }` for the last 7 UTC days, newest first (`baselineViews`,
  `playbackViews`, `playbackWatchSec`, `playbackProfiles`). Diagnostics: `not_found` when
  `WEBFLIX_ENV=production`.

**Changed routes (backward compatible)**

- `DELETE /playback/sessions/:id` accepts an optional body, the final heartbeat
  (`HeartbeatBody`). With it: the session's own profile records its final position under every
  heartbeat rule and the slot is freed in one request; new possible errors `not_found` and
  `playback_session_ended` (only when a body is sent). Without a body: unchanged. Send it
  instead of a final heartbeat followed by a release.
- `PUT /session/profile`: only a PIN submitted for a locked profile counts against
  `profile-pin` (per account); selecting an unlocked profile is never rate limited.
- `PUT /account/subscription`: a request that carries `payment` counts against the new `payment`
  limit (per account); without a card, unchanged.

**DTO fields (all optional; absent from older servers)**

- `TitleCard.top10Rank` (and so `TitleDetail`, every row item): rank 1–10 in the Top 10 list of
  the surface's view, badge or not. Show "#N on Webflix Today" / "#N in Series Today" from it.
- `TitleCard.bestVideoQuality`, `PlaybackSession.bestVideoQuality`: `VideoQualityTier` (`sd`,
  `hd`, `full-hd`, `4k`), absent for external fallback media. Show
  `effectiveVideoQuality(bestVideoQuality, plan.maxVideoHeight)` labelled with
  `videoQualityLabel`; never more than the plan allows.
- `TitleCard.badge` keeps its type; its *selection* changed: `top-10` only for titles in the
  surface view's Top 10, never in `continue` or `ranked` rows, at most `TOP_10_BADGES_PER_LIST`
  (2) per list.

**Schemas**: `UpdatePaymentMethodBody`, `Showcase`, `ShowcaseTitle`, `TitlePopularity`,
`TitlePopularityDay`, `VideoQualityTier`.

**Constants and helpers** (zod-free): `VIDEO_QUALITY_TIERS`, `VIDEO_QUALITY_MIN_HEIGHT`,
`VIDEO_QUALITY_LABELS`, `SHOWCASE_SIZE`, `SHOWCASE_MATURITY_CEILING`, `TOP_10_BADGES_PER_LIST`;
`nominalVideoHeight`, `videoQualityForHeight`, `effectiveVideoQuality`, `videoQualityLabel`.
`RATE_LIMIT_POLICY_NAMES` gains `payment` (config `WEBFLIX_RATE_LIMIT_PAYMENT`, default 10/600).

**Route-table mechanics** (for anyone adding routes)

- `RouteSpec.rateLimitScope?: "request" | "handler"` (default `request`). `handler`: only the
  requests the route's description names consume its policy, enforced by the handler; OpenAPI
  `x-webflix-rate-limit-scope: handler`.
- A body schema that accepts `undefined` (`Schema.optional()`) makes the body optional:
  `isBodyOptional(route)`, `body?` in `RouteInput`, `requestBody.required: false` in OpenAPI,
  and the server parses a body only when one is sent.
- `RouteSpec.examples?: { request?, response? }`: OpenAPI `example`s on the request and success
  bodies; a test parses each with the route's schemas. Every new route has them.

**Error codes**: none added (`not_found`, `playback_session_ended`, `payment_declined` and
`rate_limited` cover the new cases with their existing meaning).

## 2026-11-21 — backend round 2: privileges, credential budget, quality cap, hardening

Fields, schemas, codes and the route-table value below are additive. Several *behaviours*
change on purpose (security fixes); each says what a client sees and what to do. Reasons are in
`docs/DECISIONS.md` D24–D40; the privilege table is in `docs/BACKEND.md` §3.

**Error codes (5 added, all 403)**: `password_required` (a password is needed and none was
sent), `profile_unlock_required` (a locked profile changed or deleted from another session
without its `currentPin` or `currentPassword`), `unrestricted_profile_required` (a kids or
restricted profile attempted account management or a profile change it may not make),
`demo_account_protected` (the shared demo account's sign-in details, membership, other devices
and profiles), `media_quality_restricted` (a rendition above the plan's cap).

**Route table**: `RouteAuth` gains `"account-holder"`: a signed-in session whose active profile
has no parental controls; otherwise `profile_required` (no active profile) or
`unrestricted_profile_required`. OpenAPI `x-webflix-auth: account-holder`. `routeErrorCodes`
adds both codes for it. `RATE_LIMIT_POLICY_NAMES` gains `auth-email` and `playback-start`
(config `WEBFLIX_RATE_LIMIT_AUTH_EMAIL`, default 10/900; `WEBFLIX_RATE_LIMIT_PLAYBACK_START`,
default 60/60). `PASSWORD_MAX_BYTES` (1024) is new.

**Schemas and fields (optional; absent from older servers)**

- `ProfileList.parentalControls?: boolean`: any kids profile, lowered ceiling or PIN lock. When
  `true`, adding a profile needs `currentPassword`.
- `Account.isDemo?: true` on the demo account.
- `CreateProfileBody.currentPassword?`, `UpdateProfileBody.currentPin?`, and the new
  `DeleteProfileBody { currentPin?, currentPassword? }`, an optional body of
  `DELETE /profiles/:id` (example in OpenAPI).
- `Password` (sign-up, new password) also refuses more than `PASSWORD_MAX_BYTES` of UTF-8 after
  NFKC normalisation: `validation_failed` on `password` (it answered 500 after charging the
  card).

**Changed behaviour (what a client sees)**

- Account routes (`GET`/`PATCH /account`, `PUT`/`DELETE /account/subscription`,
  `POST /account/subscription/resume`, `PUT /account/payment-method`, `GET /account/sessions`,
  `DELETE /account/sessions/:id`, `POST /auth/logout-all`) are `account-holder`: from the gate
  they answer `profile_required` (show "Who's watching?"), from a kids or restricted profile
  `unrestricted_profile_required`. `POST /auth/logout` stays open to every session.
- A kids profile may only switch profile and change its own name, avatar and settings.
- `POST /profiles` while parental controls are in use, and loosening a profile (ceiling up, kids
  off, PIN set/changed/removed), answer `password_required` without `currentPassword` (they
  answered `current_password_invalid` for a missing password before; a wrong one still does).
- Changing or deleting a locked profile from a session that is not on it needs `currentPin` or
  `currentPassword` (`profile_unlock_required`, `profile_pin_invalid`).
- Every PIN or password check after sign-in counts against `profile-pin` (per account), not only
  a PIN at the gate; `PATCH /account` and the profile routes can answer `rate_limited`.
- Setting or changing a PIN signs every other device off that profile: its next request answers
  `profile_required`.
- The demo account answers `demo_account_protected` to the changes listed above.
- `POST /auth/login` is also limited per email address (`auth-email`); sign-up and sign-in set a
  second cookie, `webflix_device` (`__Host-webflix_device` on https, HttpOnly, a year), which
  exempts that browser from the per-email limit. Clients that keep only one cookie must keep
  the session cookie by name.
- `POST /playback/sessions` is limited per account (`playback-start`).
- Media: playlists and segments of a rendition above the plan's cap answer
  `media_quality_restricted`; `/cdn` and `/media` paths that are not valid blob keys answer
  `not_found` (they could answer 500).
- Cursors: a search cursor that does not decode answers `validation_failed` (it restarted at
  page one); browse batch and row cursors now carry what they served (still opaque; older
  offset cursors are accepted).
- Routes with an optional body treat an empty or whitespace-only body as none, whatever
  `Content-Type` says.
- A database that cannot be reached answers `service_unavailable` (503) with `Retry-After`
  (it answered 500).

## 2026-11-22 — round 5: previews, durations, badges, search length (all additive)

- **`PreviewClip.kind?: "footage" | "motion"`** (`PREVIEW_KINDS`, `PreviewKind`) and
  **`PreviewClip.hasAudio?: boolean`**: on every card (so detail and billboard too). Current
  servers always send both; absent (older servers) means footage with audio. Offer no sound
  control for `hasAudio: false`; describe motion art as such.
- **Media manifest**: `PackagedVideoAsset.preview.kind?` and `.hasAudio?`, same meaning; absent
  means footage with audio, so existing manifests stay valid.
- **Durations** (no field change): `TitleCard.runtimeSec`, `EpisodeSummary.runtimeSec` and
  `NextEpisode.runtimeSec` are the playable duration of packaged media (the same base as
  `PlaybackSession.durationSec` and progress), the catalogue runtime only for external fallback
  media. Values change once the seed re-applies (format 4).
- **Search**: `SearchQuery.q` accepts up to `SEARCH_QUERY_INPUT_MAX_LENGTH` (2000, new) and
  searches its first `SEARCH_QUERY_MAX_LENGTH` (100) characters, cut between code points; a query
  of 101 to 2000 characters used to be `validation_failed`. `SearchResults.query` is the query as
  searched. Cap the field at 100 client-side.
- **`BADGES_PER_LIST`** (2, new): badges of any kind per list. The server also stops sending
  badges on the Top 10 row, sends only `new-episodes` in Continue Watching, and never `new` on a
  title the profile has played (RECOMMENDATIONS.md, Badges).
- **Notifications** (behaviour): a new profile's arrivals from before it was created come read
  (at most three); `unreadCount` counts only later ones.

## 2026-11-22 — milestone 2 foundation (all additive; no client has to change)

The contract of milestone 2 (docs/BLUEPRINT-M2.md), registered and documented ahead of its
implementation. Every change is additive: milestone 1's routes, fields, codes and constants keep
their meaning and every milestone 1 client works unchanged. A route listed here that its area has
not built yet answers **`501 not_implemented`** (`operationId`, `area`) to everyone, before
authentication and validation; the served OpenAPI document marks it
`x-webflix-implementation: pending` (docs/FOUNDATION.md §8). Do not build UI against a pending
route's success path yet; its schemas are the contract its area implements.

**Route table mechanics** (`src/route.ts`)

- Every route names its `area` (`ROUTE_AREAS`: identity, billing, events, personalisation,
  experiments, admin, streaming); the member table is split into one file per area under
  `src/routes/` and composed in `src/routes.ts` (same `routes` object, same operation ids).
- New `RouteSpec` fields: `redirect` (302/303: a browser navigation; the handler returns
  `{ location }`), `bodyEncoding` (`json` | `form` for an issuer's form post | `raw` bytes for a
  signed webhook), `csrf: "none"` (callers that cannot send `X-Webflix-Client`: form posts and
  webhooks, authenticated otherwise), `maxBodyBytes`, `auth: "staff"` with `staffRole`.
- Redirect, form and raw routes are not methods of the typed client (`IsClientRoute`,
  `ClientRoutes`); `navigationUrl("startOidc", …)` builds the URL of a navigation.
- **The staff API**: `adminRoutes` under `ADMIN_API_BASE_PATH` (`/api/admin/v1`), bearer tokens
  (`Authorization: Bearer`), typed client `createAdminApiClient({ accessToken })`. One OpenAPI
  document covers both APIs (`buildOpenApiDocument()` defaults to `API_MOUNTS`), with a
  `staffBearer` security scheme and `x-webflix-area` / `x-webflix-staff-role` on operations.
- `ROUTE_INDEX` holds client routes only; `NAVIGATION_ROUTE_INDEX` and `ADMIN_ROUTE_INDEX` are new
  (all generated, zod-free).
- Rate-limit policies added: `oidc`, `email-send`, `email-send-recipient`, `events`, `promotion`
  (limits in docs/BACKEND.md §3).
- Route tags added: `billing`, `events`, `privacy`, `webhooks`, `diagnostics`, `admin`.

**Member routes added (32; the table now has 78)**

- Identity (§4): `GET /auth/oidc/:provider/start` (302), `GET` and `POST
  /auth/oidc/:provider/callback` (303 to `returnTo?oidc=<OIDC_OUTCOMES>`; POST is Apple's form
  post), `GET /account/identities`, `DELETE /account/identities/:provider`, `GET` and `POST
  /session/elevation` (the account-holder proof), `POST /auth/email-verification`, `POST
  /auth/email-verification/confirm`, `POST /auth/password-reset`, `POST
  /auth/password-reset/confirm`, `POST /webhooks/email/:provider` (raw), `GET
  /diagnostics/mailbox` (not in production).
- Billing (§5): `GET /billing/config`, `POST /billing/checkout`, `GET /billing/checkout/:id`,
  `POST /billing/checkout/:id/confirm` (the two-step flow), `POST /billing/subscription/preview`,
  `POST /billing/payment-method/setup`, `GET /billing/payment-method/setup/:id`, `GET
  /billing/invoices`, `POST /billing/promotions/validate`, `POST /webhooks/payments/:provider`
  (raw), `POST /diagnostics/billing/clock` (not in production).
- Events and privacy (§6): `POST /events` (202, at most 50 events and 64 KiB), `GET` and `PUT
  /privacy/consent`, `POST /privacy/export`, `GET /privacy/requests`, `POST` and `DELETE
  /account/deletion`, `GET /diagnostics/events` (not in production).

**Staff routes added (32)** (§8.3): `GET /me`; members (`GET /members`, `GET
/members/:accountId`, sign out everywhere, send a password reset, remove a PIN); billing actions
(refund, cancel, extend a trial, complimentary period); plans and prices (`GET /plans`, `PUT
/plans/:planId/prices/:currency`, `POST /plans/sync`); editorial (billboards per view, curated
collections, title availability); experiments (list, create, get, update, status, results);
system (health, dead letters with replay, recommendation status and import); the audit log.
Every mutating staff route takes a `reason`.

**Changed routes (backward compatible)**

- `GET /session` accepts an optional `deviceId` query (the experiment unit before sign-in).
- `PUT /account/subscription`: `ChangePlanBody.previewToken` (optional) applies a plan change
  exactly as previewed.

**DTO fields (all optional; absent until their area serves them)**

- `Account.emailVerified`, `Account.hasPassword` (identity).
- `AccountDetails.membership` (`MembershipState`: the §5.2 projection) and
  `AccountDetails.entitlement` (`Entitlement`) (billing).
- `AnonymousSession.experiments`, `AuthenticatedSession.experiments` (`ExperimentAssignments`).
- `BrowsePage.policy` (`RankingPolicy { id, explore }`): copy it into impressions and
  title-opens.
- `Plan.trial` (`PlanTrial | null`): absent until billing offers trials (milestone 1's sign-up
  charges at once, so none may be advertised before then).
- `subscription_required` problems gain an optional `membershipStatus`.

**New schemas**: `billing.ts`, `identity.ts`, `events.ts`, `privacy.ts`, `experiments.ts`,
`admin.ts` (see each module's doc comment); `SignedMoney`, `PlanTrial`, `RankingPolicy`,
`DeviceId`, `SessionQuery`.

**Error codes added**: `not_implemented` (501; `operationId`, `area`),
`reauthentication_required` (403), `verification_token_invalid` (400),
`identity_already_linked` (409), `identity_last_sign_in_method` (409),
`promotion_code_invalid` (422; `promotionReason`), `payment_action_required` (402;
`clientSecret`), `checkout_state_conflict` (409), `webhook_signature_invalid` (400),
`privacy_request_pending` (409), `experiment_conflict` (409), `staff_role_required` (403;
`requiredRole`).

**Constants added** (`constants.ts`, zod-free): OIDC providers, intents, outcomes and
`OIDC_RESULT_PARAM`; `REAUTH_METHODS`, `ELEVATION_TTL_SEC`, email token lifetimes; payment
providers, `MEMBERSHIP_STATUSES`, `SUSPENDED_REASONS`, `ENTITLEMENT_REASONS`, `TRIAL_DAYS`,
checkout, invoice, setup and promotion vocabularies; event types (client and server), sources,
platforms, surfaces, row kinds, batch limits, `EVENT_LAKE_PREFIX`; consent purposes, sources and
modes; privacy request kinds and statuses; experiment statuses, metrics, audiences,
`EXPERIMENT_BUCKETS`; `STAFF_ROLES`, `STAFF_CLIENT_ID`, `STAFF_API_AUDIENCE`, audit actor types;
email templates and suppression reasons. `ROW_KINDS` gains `top-picks` (informational: the web
never switches on `kind`).

**Behaviour events** (`events.ts`, the single source): `LakeEvent` (stored), `ClientEventInput`
(what `POST /events` accepts: no `source`, `receivedAt` or `subject`, and a client-supplied
identity is refused rather than ignored), `EventBatch`, `EventBatchAck`, one payload schema per
type. `@webflix/contracts/event-schema` exports the JSON Schema the pipeline reads;
`pnpm --filter @webflix/contracts generate` writes `services/recs/schemas/event.schema.json`.
Adopted from the pipeline's provisional schema and its fifteen decisions, with three corrections:
title and episode ids use the contract's `Id` pattern; client events require `deviceId`,
`sessionSeq` and a client platform while server events have the `server` platform and a null
`sessionSeq`; `auth.signin` and `auth.signup` carry no profile.

**Fixtures**: `makeLakeEvent(type)`, `makeClientEventInput(type)`, `SAMPLE_EVENT_PAYLOADS`.

**Planned breaking changes (not made here; each owner makes them with the web adoption)**

- Billing: remove the card fields (`SignupBody.payment`, `ChangePlanBody.payment`,
  `UpdatePaymentMethodBody`) and empty `LEGACY_CARD_FIELDS` in
  `packages/contracts/test/no-card-data.test.ts`, which fails on any other card field; make
  `AuthenticatedSession.subscription`/`plan` and `AccountDetails.subscription`/`plan` nullable
  for a membership `none` (§5.1); extend `PAYMENT_DECLINE_REASONS` (the web switches on it
  exhaustively).
- Identity: `SignupBody` loses `planId` (plan choice moves to checkout, §5.1).

## 2026-11-22 — events area: behaviour collection, consent, export, deletion (additive)

The events area implemented its routes (milestone 2 §6). Everything below is additive: no
event type, field or code changed, and the event JSON Schema the pipeline reads is unchanged.

- **New route `GET /privacy/exports/:id?token=`** (`downloadDataExport`, `account-holder`):
  the signed link of a completed export (`PrivacyRequest.downloadUrl`), answering the new
  `DataExport` document as an attachment (`Content-Disposition`). The token is bound to the
  request and the account and expires with `expiresAt`; anything else is `not_found`. The
  milestone 2 foundation had `downloadUrl` but no route serving it.
- **New schemas** (`privacy.ts`): `DataExport` (`format: "webflix.data-export"`,
  `formatVersion: 1`: account, membership, profiles, devices, per-profile library and history,
  consents, privacy requests, `events: LakeEvent[]`, `areas` for the other areas' parts,
  `notes`), `DataExportParams`, `DataExportQuery`.
- **`POST /events`** (`ingestEvents`): `rateLimitScope: "handler"` (OpenAPI
  `x-webflix-rate-limit-scope: handler`): the handler charges the `events` policy twice per
  request, per account (signed out: per client address) and per device. A batch must carry one
  `deviceId` (else `validation_failed` on `events`). Request and response examples added.
  `503 service_unavailable` when the batch cannot be queued (retry it).
- **Behaviour the contract leaves to the server** (docs/BACKEND.md §3, "Behaviour events and
  privacy"): consent modes and Global Privacy Control, the export's contents, the deletion's
  cooling-off period and what erasure keeps.

## 2026-11-22 — personalisation and experiments: learned candidates, editorial rows (additive)

Recommendation serving and experimentation were built (milestone 2 §7.2, §8.1; docs/RECOMMENDATIONS.md,
"Learned candidates"). No route, field or error code changed; one constant gained a value.

- **`ROW_KINDS` gains `collection`**: a curated collection staff published on a view (§8.3).
  Informational like every kind (render rows from `layout` and the items); its row id is
  `{view}:collection:{id}` and `GET /browse/rows/:rowId` pages it. `EVENT_ROW_KINDS` follows, so
  the generated `services/recs/schemas/event.schema.json` accepts `row.view.rowKind:
  "collection"` (the pipeline reads the enum from the schema; its tests pass).
- **`BrowsePage.policy` is now always sent**: `{ id, explore }`, `id` being `rules` (the rule
  engine built the page) or `learned:{run}` (learned candidates of the model run `run`), and
  `explore: true` on an exploration page (rows and non-canonical items in random order). Copy it
  verbatim into impressions and title-opens.
- **Rows that now appear**: `top-picks` ("Top Picks for {name}", after Continue Watching) for
  profiles the model scored, and `collection` rows where staff published them.
- **A title staff made unavailable** (or outside its availability window) is in no browse row,
  billboard or genre page, and not in search results or title suggestions; `GET /titles/:id`,
  its episodes and More Like This answer `not_found` for it (the code a link to a title the
  catalogue never had gets). No new code: clients already handle `not_found` on a stale link.
- Unchanged for clients: the staff routes for experiments, editorial data and recommendation
  status still answer `501` until the admin area wires them to the service methods.

## 2026-11-22 — identity area: federated sign-in, the account-holder proof, email (backward compatible)

The identity area implemented its thirteen milestone 2 routes (§4, §8.2) and changed four of its
own declarations. A client built against the foundation keeps working: every request it sends
is still accepted and answered as before; what is new is optional or an extra error code.

- **`SignupBody.planId` and `SignupBody.payment` are optional, together** (`validation_failed`
  on `planId` when only one is sent). Without them (§5.1) sign-up creates the account and a
  session with **no membership**; the response is unchanged in shape: until billing makes
  `AuthenticatedSession.subscription`/`plan` nullable (its planned breaking change), such an
  account is presented as an `ended` membership on the `basic` plan, from the moment it was
  created. With both, milestone 1's sign-up is unchanged. Either way a verification link is
  emailed.
- **`UpdateAccountBody.currentPassword` is optional**: without it, a fresh account-holder proof
  held by the session (§4.2: `POST /session/elevation`, or a fresh sign-in with a linked issuer)
  is required instead; neither → **`password_required`** (now in `updateAccount.errors`). An
  account created through an issuer has no password and sets its first one this way. A new
  address is unverified until its link is followed; email and password changes send a security
  alert.
- **`startOidc.errors` gains** `reauthentication_required` (`intent=link` without a fresh proof),
  `profile_required` and `unrestricted_profile_required` (`intent=link` needs an account holder)
  and `demo_account_protected`. An issuer that cannot be reached is not an error: the browser is
  sent back to `returnTo?oidc=failed`.
- **Served now** (were "absent until identity serves it"): `Account.emailVerified` and
  `Account.hasPassword` on the session and the sign-in and sign-up responses.
- **Implemented** (no schema change): `GET /auth/oidc/:provider/start`, both callbacks (always a
  303 to `returnTo?oidc=<OIDC_OUTCOMES>`), `GET`/`DELETE /account/identities`, `GET`/`POST
  /session/elevation` (each attempt counts against `profile-pin`), `POST
  /auth/email-verification` and `/confirm`, `POST /auth/password-reset` (always 204) and
  `/confirm`, `POST /webhooks/email/:provider` (`resend`: Svix signature over the raw body),
  `GET /diagnostics/mailbox`. Email links put the token in the URL **fragment**:
  `{origin}/verify-email#token=…`, `{origin}/reset-password#token=…` (the web reads it and
  posts it to the confirm route).
- **Behaviour the contract leaves to the server**: the linking rule, the proof, tokens, the
  mailbox and the stand-in membership are in docs/BACKEND.md §3 ("Sign-in, milestone 2").
- **Not changed**: `OIDC_OUTCOMES`, `REAUTH_METHODS`, error codes (none added), the callback
  and webhook schemas.

## 2026-11-22 — billing (milestone 2 wave): the membership is served; all additive

No route, schema field or error code was renamed or removed; a client built against the
foundation's contract keeps working. Milestone 1's card fields (`SignupBody.payment`,
`ChangePlanBody.payment`, `UpdatePaymentMethodBody`) stay until the web checkout replaces them
(`LEGACY_CARD_FIELDS` unchanged).

- **`AuthenticatedSession.membership?` and `.entitlement?`** (new, optional): the same
  `MembershipState` and `Entitlement` as `GET /account`. **The shape of "no membership"**
  (decided here, replacing the identity area's stand-in): `membership.status: "none"`,
  `entitlement: { entitled: false, reason: "no_membership" }`, while the still-required
  `subscription` and `plan` show an **ended Basic membership since the account was created**
  (`startedAt` = `currentPeriodEnd` = `canceledAt` = the account's creation). Making
  `subscription`/`plan` nullable stays the planned breaking change of the web adoption; new
  clients should read `membership`.
- **Served now** (were "absent until billing serves it"): `AccountDetails.membership` and
  `.entitlement` for every account (a milestone 1 mock membership reads `provider: null`,
  `active` or `canceled`); `Plan.trial` (`{ days: 7 }` on every plan; one trial per account and
  per card, decided at checkout confirmation); `subscription_required.membershipStatus`.
- **Implemented** (no schema change): `GET /billing/config`, `POST /billing/checkout`, `GET
  /billing/checkout/:id`, `POST /billing/checkout/:id/confirm`, `POST
  /billing/subscription/preview`, `POST /billing/payment-method/setup`, `GET
  /billing/payment-method/setup/:id`, `GET /billing/invoices`, `POST
  /billing/promotions/validate`, `POST /webhooks/payments/:provider` (the `Stripe-Signature`
  header, for the fake provider too), `POST /diagnostics/billing/clock`.
- **Behaviour of milestone 1's membership routes**: for an account whose membership is the
  provider's, `PUT /account/subscription` changes plan at the provider (with `previewToken`:
  exactly as previewed; a decline is `payment_declined` and changes nothing), `DELETE` sets
  cancel-at-period-end and `POST …/resume` undoes it (an ended membership answers
  `checkout_state_conflict`: restart with a checkout). `PUT /account/payment-method` answers
  `checkout_state_conflict` for such an account (use the setup flow). For an account without a
  membership the mock-billing routes answer `subscription_required`. Accounts on the mock
  membership: unchanged.
  Their `errors` lists gain those codes (`subscription_required`, `checkout_state_conflict`),
  so the OpenAPI document says so.
- **`GET /plans`** reads the plan prices from Webflix's price table (seeded with the same
  amounts; staff can change them).
- **Promo codes**: a percentage discount is rounded on the discount, as Stripe does (50% off
  799 is 399, docs/STRIPE.md §7). The `promotion` rate limit is keyed per account (it was keyed
  per client address by default), as docs/BACKEND.md §3 documents.
- **Not changed**: `PAYMENT_DECLINE_REASONS` (a provider's other decline codes map to
  `card_declined`, `insufficient_funds` or `expired_card`), `CHECKOUT_STATUSES`, every error code.

## 2026-11-22 — identity fix round: offered issuers, callbacks that always redirect (additive)

- **New route `GET /auth/providers`** (`listSignInProviders`, public, a client method):
  `SignInProviders { items: SignInProvider[] }`, each `{ id: OidcProviderId, displayName }`, in
  button order; empty when only password sign-in is offered. Read from configuration (no
  database round trip), the same for every visitor, `Cache-Control: public, max-age=300`. Show a
  button per item and send it to `GET /auth/oidc/{id}/start`. A small route of its own rather
  than a field of `GET /session`: that response is per-browser and never cached, while this one
  is public and changes only with configuration. New schemas: `SignInProvider`,
  `SignInProviders`.
- **The OpenID callbacks never answer a problem document** (`GET` and Apple's form `POST
  /auth/oidc/:provider/callback`): a request refused before the handler (an invalid query or
  form, a repeated, oversized or mistyped form body, an unknown issuer, the `oidc` rate limit) is
  answered like every other failure, `303` to the transaction's `returnTo` (or `/`) with
  `?oidc=failed`, and the transaction cookie is dropped. The rate limit is still charged and
  enforced; only its rendering on these two navigations changed (`GET /auth/oidc/:provider/start`
  still answers `rate_limited`). The server logs `identity.oidc_refused` with the refusal's code.

## 2026-11-22 — events fix round: abandonment of unreleased sessions, export layout

- **`PLAYBACK_ABANDON_REASONS` gains `expired`** (appended): a playback session nobody released
  (its stream slot lapsed and no report came back, e.g. a killed tab) is ended by the events
  area's sweep with `playback.abandon { reason: "expired" }`. `stalled` keeps its meaning (a
  report found its slot gone). The event version stays 1; `services/recs/schemas/event.schema.json`
  is regenerated (the reason's enum). Readers that switch on the reason: add the value.
- **`DataExport.membership` removed** (breaking for a reader of the export document; no client
  reads it yet): the membership and invoices are billing's part of the export,
  `DataExport.areas.billing`, beside identity's (`areas.identity`: sign-in methods, email
  verification). A member without a membership now gets an export too.


## 2026-11-22 — admin area: the staff API is implemented (staff routes changed)

All 32 staff routes are implemented, and six are added (38). The staff routes had answered `501`
until now and no client calls them yet, so the changes below break nobody; the member API is
unchanged. Behaviour for the console and operators: docs/BACKEND.md §3, "The staff API".

- **`idempotencyKey` is required** (breaking for the staff routes' old shape) on `RefundBody`,
  `CancelMemberSubscriptionBody`, `ExtendTrialBody` and `ComplimentaryPeriodBody`:
  `IDEMPOTENCY_KEY_PATTERN` (16-64 of `[A-Za-z0-9_-]`, a UUID fits). Generate it once per
  submitted form and resend it on every retry: a retried refund never refunds twice. A retry of a
  succeeded request answers the original response; while the first runs, after it failed or ended
  unknown, with other parameters or by another staff member: **`staff_action_conflict`** (409,
  new code; also a dead letter replayed twice).
- **The audit log lists `AuditLogEntry`** (new schema): `AuditEntry` (unchanged: what the
  experiments and personalisation areas write with their changes) plus `outcome`
  (`AUDIT_OUTCOMES`: `pending`, `succeeded`, `failed`, `unknown`; schema `AuditOutcome`) and
  `completedAt`. `AuditPage` items are `AuditLogEntry`; `AuditQuery` gains an `outcome` filter.
  Reads of member data are entries too (`member.viewed`, `member.searched`,
  `member.privacy_viewed`).
- **New staff routes**, closing the two gaps the contract had (support's privacy actions, the
  operator's erasure and rollback):
  - `GET /members/:accountId/privacy` (`getMemberPrivacy`, `support`): `MemberPrivacy { consent:
    ConsentState, requests: PrivacyRequest[] }`, `downloadUrl` always null.
  - `PUT /members/:accountId/privacy/consent` (`setMemberConsent`, `support`):
    `SetMemberConsentBody { purpose, granted, reason }` → `ConsentState` (recorded with source
    `support`).
  - `DELETE /members/:accountId/deletion` (`cancelMemberDeletion`, `support`): `ReasonBody`, 204;
    `not_found` when no deletion is scheduled.
  - `GET /system/privacy/erasures?limit=` (`listPendingErasures`, `admin`): `PendingErasures {
    subjectKeys }` for the lake's compaction (`compact --erase`).
  - `POST /system/privacy/erasures/confirm` (`confirmErasures`, `admin`): `ConfirmErasuresBody {
    subjectKeys (1-200), reason }`, 204.
  - `POST /system/recommendations/rollback` (`rollbackRecommendations`, `admin`): `ReasonBody` →
    `RecommendationStatus`; `not_found` without a previous run.
  Deliberately not exposed: the events area's read-back of a member's behaviour events (no
  support task needs it) and the export document or its link.
- **Error lists** (documentation): the billing actions list `checkout_state_conflict`,
  `subscription_required` and `staff_action_conflict` where the service can answer them;
  `replayDeadLetter` lists `staff_action_conflict`.
- **Constants**: `AUDIT_OUTCOMES`, `AuditOutcome`, `IDEMPOTENCY_KEY_PATTERN`.
- **Schemas**: `IdempotencyKey`, `AuditOutcome`, `AuditLogEntry`, `MemberPrivacy`,
  `SetMemberConsentBody`, `PendingErasuresQuery`, `PendingErasures`, `ConfirmErasuresBody`.

## 2026-11-22 — admin fix round: the operator's side of members' data exports (additive)

The events part of a data export is produced in a deployed mode by the pipeline's
`export-events` job (services/recs/README.md, "Exports of members' events"), on the pattern of
erasure. Two staff routes, role `admin`, shaped as the job expects (40 staff routes now):

- `GET /system/privacy/exports?limit=` (`listPendingExports`): `PendingExports { requests:
  [{ requestId, accountKey, from, to }] }`: the exports whose events are not extracted yet, with
  the account's pseudonymous key and the receipt window `[from, to)`; listed until a result is
  recorded.
- `POST /system/privacy/exports/results` (`recordExportResults`): `ExportResultsBody`, the
  job's results document (`format: "webflix.export-events-results"`, `formatVersion: 1`,
  `generatedAt`, `results` of at most 500) plus `reason`; 204. A result's `file` and `manifest`
  can only be that request's own documents (`privacy/export-events/{requestId}/events.ndjson.gz`,
  `…/manifest.json`), and a `complete` result must carry `file`, `bytes` and `sha256`
  (`validation_failed` otherwise). Unknown members of the document are dropped, never stored.
  Audited like the erasure confirmation (`privacy.export_events_recorded`, written before the
  call and settled after); the entry keeps the request ids, statuses, file locations, sizes and
  hashes, never a download link.
- **Schemas**: `PendingExportsQuery`, `PendingExports`, `ExportResultsBody`.

## 2026-11-22 — billing fix round (no schema change)

- **`membership.status: "none"` now always reads as no membership**: `planId`, `provider`,
  `currentPeriodEnd`, `trialEndsAt`, `graceEndsAt` and `suspendedReason` are null, as
  `MembershipState` says (they leaked from an expired first payment: finding M2-F4), and the
  entitlement is `no_membership`.
- **A first payment never confirmed is `none`, never `canceled`**, whether it expired at the
  provider or the member abandoned it by starting a checkout for another plan (§5.2; finding
  M2-F3). A trial cancelled before its end, or a paid membership that ended, stays `canceled`.
- Fake provider (local modes only, not the contract): standing promo code `WEBFLIX50` (50% off
  any plan, unlimited) by default, `WEBFLIX_PAYMENTS_FAKE_PROMOTIONS`; labelled test cards
  `<test card>:<label>` for a card that never had a trial (docs/BACKEND.md §3).

## 2026-11-22 — personalisation fix round: policy labels, import capacity (additive)

- **`BrowsePage.policy.id` has three values** (the field stays free text, 1 to 64 characters, so
  `RankingPolicy`, `EventPolicy` and the generated event schema are unchanged): `rules` (nothing
  from a model shaped the page, the control arm of `recs.learned-vs-rules` included),
  `neighbours:{run}` (a fresh model's neighbours helped the rule engine; the profile has no
  personal list) and `learned:{run}` (a fresh personal list ranked the page). Copy it verbatim
  into impressions and title-opens as before. A profile the model never saw is no longer labelled
  `learned:{run}`.
- **New error code `recommendation_import_too_large` (422)**: `POST
  /api/admin/v1/system/recommendations/import` refuses, before queueing anything, a run with more
  per-profile lists than one Worker invocation can write (Cloudflare); `detail` names the importer
  outside the Worker (`make cf-recs-import`). The admin route table does not list it in `errors`
  yet (the admin area's file).

## 2026-11-22 — identity fix round 2: removed identities stay removed, passwordless proofs

- **An unlinked issuer identity never links itself again** (behaviour; finding M2-F5): after
  `DELETE /account/identities/:provider` the same identity's next sign-in answers
  `?oidc=link-required` even when both addresses are verified; only `intent=link` (an account
  holder with a fresh proof) brings it back. The same holds for an identity a completed password
  reset dropped. No schema change; a removed identity may still sign up a new account for an
  address no account has.
- **`password_required` for an account without a password** (behaviour): `POST /session/elevation`
  and every route that takes `currentPassword` (account changes, creating, loosening, unlocking or
  deleting a profile) answer `403 password_required` when the account has no password (created
  through an issuer), whatever is sent; they had answered `current_password_invalid`. The proof
  for such an account is a fresh sign-in (`intent=reauth`) or setting a password. Documentation:
  `deleteProfile.errors` lists `password_required`; `elevate`'s description says so.
- **Identity's part of a data export** (`DataExport.areas.identity`, the document behind
  `GET /privacy/exports/:id`) adds `emailVerifiedAt`, `hasPassword`, the member-visible
  `profiles` (name, avatar, kids flag, maturity ceiling, locked, settings, created; never the PIN)
  and `devices` (the signed-in sessions: label, type, signed in, last seen, expires; never a
  token). The events area reads them from here instead of from milestone 1's tables.
- **`POST /system/recommendations/import`** (`importRecommendations`) lists
  `recommendation_import_too_large` (422, the personalisation area's new code) in its `errors`: a
  run larger than the runtime can write in one invocation is refused before anything is queued,
  and the detail names the importer that runs outside the Worker. The staff audit entry of such
  a refusal is `failed` (nothing changed).
- **`GET /system/privacy/exports`** answers the events area's list as it is (`{ requests }`);
  the audit entry of `POST /system/privacy/exports/results` keeps, as `after`, what became of each
  request by id (`completed`, `erased`, `kept`, `ignored`), request ids only.

## 2026-11-22 — experiments fix round: status changes take effect at one instant (additive)

- **`ExperimentDefinition` gains `statusChangeAt` (ISO or null) and `previousStatus` (a status or
  null)**: when the current `status` takes effect for assignment, at the same instant on every
  replica and isolate, and the status assignment follows until then (finding K4, several
  replicas caching the definitions). `PUT /api/admin/v1/experiments/:key/status` answers with
  the new `status` at once and `statusChangeAt` = now + `WEBFLIX_EXPERIMENTS_PROPAGATION_SEC`
  (60 s on k8s and Cloudflare, `null` in dev, where it is immediate); starting a draft also sets
  `startsAt` to that instant when it was earlier or unset. A client that needs the experiment
  live (the conformance suite) waits until `statusChangeAt` has passed; from then every instance
  assigns the same way.

## 2026-11-22 — billing fix round 3: no provider says so; checkouts and card changes settle in any order (additive)

- **`BillingConfig` gains a third variant, `{ "provider": "none" }`** (finding K3): a deployment
  with no payment provider (`WEBFLIX_PAYMENT_PROVIDER=none`, now production's default instead of
  the in-process `memory`, which production refuses like `fake`) says so instead of advertising
  the fake's form. Clients switch on `provider`; `none` means memberships cannot be started here.
- **New error code `payments_not_configured` (503)**: answered by `POST /billing/checkout`,
  `POST /billing/checkout/:id/confirm`, `POST /billing/promotions/validate` and
  `POST /billing/payment-method/setup` when the provider is `none` (listed in their `errors`).
  Not a transient outage: do not retry. `POST /webhooks/payments/:provider` answers `not_found`
  for every provider then. Every answer comes from configuration alone, identical on every
  replica; nothing is held per process.
- **Behaviour, no shape change** (finding K1): a checkout's status follows the membership on
  every read of the provider, not only when the membership changed, so the order in which the
  confirmation and the provider's events are handled no longer matters: `confirmCheckout`
  answers `complete` when the provider's events were processed first, and polling
  `GET /billing/checkout/:id` settles a checkout whose confirmation stopped half-way. A card
  change (`GET /billing/payment-method/setup/:id`) is recorded `succeeded` only once its last
  step (paying an open invoice) is done, and is looked at again on every poll until then.
- Fake provider (local modes, not the contract): its state is safe to share across replicas and
  isolates (finding K2); a request that keeps losing the race answers the port's retryable
  `unavailable` (the API's `service_unavailable`).

## 2026-11-23 — billing fix round 4: a request that meets a provider call in flight (behaviour, documentation)

- **No billing request answers 500 for a provider that is busy** (finding K12). With several
  replicas a member's request can meet the same idempotent provider call already running
  elsewhere (the worker, another replica): the fake answers "in flight", Stripe a 409
  `idempotency_key_in_use` (both now the port's retryable `unavailable`), or the membership
  record is contended. Such a request answers the current state where there is one, else
  `503 service_unavailable` (retry):
  - `GET /billing/payment-method/setup/:id` answers `status: "processing"` (no client secret)
    while a card confirmed at the provider is being finished elsewhere; a later poll answers
    `succeeded`.
  - `GET /billing/checkout/:id` and `POST /billing/checkout/:id/confirm` answer the checkout as
    it stands (`processing`) when the provider or the record cannot be read right then; a second
    confirmation racing the first answers the checkout once the first has moved it on, else 503.
  - Plan changes, cancel, resume and the staff actions (cancel, extend a trial, complimentary
    period) answer the membership as the provider's own answer projects it when the change was
    made but the projection cannot be written at that moment; it follows from the change's event.
  - Anything else (a provider read that fails for a moment) answers 503.
  `service_unavailable` is now listed in the `errors` of the billing member routes and of the
  staff routes that refund, cancel, extend a trial or grant a complimentary period.
- **A membership write that meets the worker's is waited out** (finding K13): a request retries
  its write up to six times within about half a second (jittered pauses of 10 to 160 ms), and a
  sync that finds the membership already as the provider has it writes nothing, so a burst of
  events no longer contends with the requests reading alongside it. Only contention that
  outlasts that falls back as above, or answers 503. `POST /diagnostics/billing/clock` always
  answers the moved clock once the provider's clock has moved (it never answers 503 for the sync
  after it; a second advance would move the clock again).

## 2026-11-23 — identity: a refused sign-in start sends the browser back (additive)

- **`GET /auth/oidc/:provider/start` refused during a browser navigation redirects** instead of
  showing a problem document: a request with `Sec-Fetch-Mode: navigate` (or, from a browser
  without Fetch Metadata, an `Accept` naming `text/html`) that the route refuses (any of its
  listed errors, the `oidc` rate limit, an invalid query) answers `303` to its `returnTo` (`/`
  when missing or not a valid same-origin path) with `?oidc=failed&oidcError=<code>`, `code`
  being the `ErrorCode` the problem document would have carried. The rate limit is still charged
  and enforced. Every other caller (no navigation header: scripts, the conformance suite, the
  page's own `fetch`) gets the problem document exactly as before.
- **New constant `OIDC_ERROR_PARAM` (`"oidcError"`)**. It appears only beside `oidc=failed`: on
  a refused start, and on a callback refused by the `oidc` rate limit (`rate_limited`; the
  callbacks' other failures stay plain `failed`). A page that reads `?oidc=` can show a notice
  per code (`rate_limited`: try again in a moment; `reauthentication_required`: confirm it's you
  again; `unauthenticated`: sign in first) and fall back to its `failed` notice for any other.

## 2026-11-23 — staff API: what building the console showed (additive, one response widened)

Seven places where the staff console had to work around the API. All additive for a client of
the previous contract except that `importRecommendations` answers 200 with more fields (its
status fields are unchanged). 44 staff routes.

- **`GET /titles`** (`searchTitles`, role `content`): `StaffTitleQuery { q?, ids?, cursor?,
  limit? }` → `StaffTitlePage { items: StaffTitle[], nextCursor }`, `StaffTitle { id, name, type,
  releaseYear, maturity, card: ImageSet }`. `q` (1-100) searches as members' search matches
  (name first), every maturity level, titles made unavailable included; `ids` (comma-separated,
  at most 50) resolves those titles in the order given, unknown ids left out, no paging; neither
  lists the catalogue by name. Nothing about members.
- **`GET /titles/:titleId/availability`** (`getTitleAvailability`, `content`) →
  `TitleAvailability`; without an override `available: true`, `availableFrom`/`availableUntil`
  null, `updatedAt: null`; `not_found` for a title the catalogue lacks.
- **`GET /titles/availability`** (`listTitleAvailability`, `content`) → `TitleAvailabilityList
  { items: TitleAvailabilityOverride[] }`, each `TitleAvailability` plus `name` (null when the
  title left the catalogue) and `unavailableNow`, by name.
- **`AuditQuery.requestId`** (`[A-Za-z0-9._-]{1,64}`): the entries of the request sent with that
  `X-Request-Id`.
- **`GET /audit/mine`** (`listOwnAuditLog`, role `any`): `OwnAuditQuery` (`AuditQuery` without
  `actorId`) → `AuditPage` of the caller's own entries, with `before` null and `after` null or
  `{ error }` (the error code an action ended with). `GET /audit` stays `admin`.
- **`staff_action_conflict` gains `auditId?`** (extension member): the earlier attempt's audit
  entry when the conflict is with one (absent for a dead letter replayed twice). `detail` keeps
  the prose.
- **`service_unavailable` from a staff billing action** (refund, cancel, extend trial,
  complimentary period) now says the outcome is unknown and names its audit entry, instead of
  the billing area's "Try again in a moment" (no shape change; the 503 before anything ran keeps
  its own detail).
- **`POST /system/recommendations/import`** (`importRecommendations`) answers **200**
  `RecommendationImportAnswer`: `RecommendationStatus` plus `outcome` (`queued`,
  `nothing_published`, `already_served`, `invalid`, `no_artefact_store`), `run` (the published
  run, when there is one) and `detail`; only `queued` queues the import. It answered 202 with the
  status and queued a job even when nothing was published. The audit entry's `after` is
  `{ outcome, run }`.
- **Schemas**: `StaffTitleQuery`, `StaffTitle`, `StaffTitlePage`, `TitleAvailabilityOverride`,
  `TitleAvailabilityList`, `RecommendationImportAnswer`, `OwnAuditQuery`.

## 2026-11-23 — privacy: the export link opens the web app, the terms before asking, a deletion stops renewals

What building the privacy screens showed. Two response fields are added as **required** (a
client of the previous contract that builds these objects, such as a mock, must add them); no
route is added or removed, and `GET /privacy/exports/:id?token=` is unchanged.

- **The export email's link** is a page of the web app, no longer the API route:
  `{WEBFLIX_PUBLIC_ORIGIN}/account/privacy/exports/{requestId}#token={token}` (`requestId` and
  `token` URI-encoded; the token is the one `downloadUrl` carries, in the fragment so the page
  load never sends it to a server, as identity's links do). The page asks the member to sign in
  (as the account holder), then calls `GET /api/v1/privacy/exports/{requestId}?token={token}`.
  `PrivacyRequest.downloadUrl` (for the signed-in privacy page) is unchanged.
- **`PrivacyRequestList.terms: PrivacyTerms`** (required): `{ deletionCoolingOffSec,
  exportLinkTtlSec, exportMode: "inline" | "batch", exportTypicalSec, eventsRetentionDays,
  aggregatesRetentionDays }`, this deployment's settings (configuration only: serving them reads
  no database). `exportTypicalSec` is the new `WEBFLIX_EXPORT_TYPICAL_SEC` (default 60 inline,
  1800 batch).
- **`PrivacyRequest.membership: DeletionMembership | null`** (required, nullable): on a deletion,
  what it did to the membership; null on an export and on a deletion recorded before this.
  `DeletionMembership { status, endsAt, resumable }`: `status` is `stopping` (billing has not
  confirmed yet; retried every scheduler tick), `ending` (set to end at `endsAt`: while the
  deletion is scheduled, the earlier of the period's close and `scheduledFor`; once cancelled,
  the period's close), `renewing` (it renews again: the member resumed it, or kept the account
  before the renewals were stopped), `ended`, or `none` (no membership a payment provider
  renews); `resumable` is true when the deletion is `canceled` and the membership is still set
  to end (offer `POST /account/subscription/resume`).
- **`POST /account/deletion`** (behaviour): the request is recorded first, then the
  membership's renewals are stopped through billing's service (`cancel`: it ends at the close
  of its period). Whatever billing answers, the deletion stands; a failure is retried by the
  `privacy.sweep` job. `DELETE /account/deletion` leaves the membership set to end.
- **Schemas**: `PrivacyTerms`, `DeletionMembership`.

## 2026-11-23 — billing: what the checkout and membership screens needed (additive)

New fields are always sent by this API; they are optional in the TypeScript types only so that
clients' fixtures keep compiling.

- **`MembershipState.nextInvoice: { at: IsoDateTime, amount: Money } | null`** (`GET /account`,
  `GET /session`, the staff member view): the next invoice as the provider previews it, its date
  (the trial's or the period's end, provider time like `currentPeriodEnd`) and its amount (the
  plan's price less live discounts and credit, e.g. a downgrade's). Null when there is none:
  cancelling, ended, unpaid, suspended, no membership, milestone 1's mock membership. Kept with the
  projection (column `memberships.next_invoice_json`, migration 0019), previewed whenever the
  projection is written; never a guess (an elapsed date reads as null until the renewal's sync).
  Port: `PaymentProvider.previewNextInvoice(subscriptionId)` (Stripe: `POST
  /v1/invoices/create_preview`).
- **`GET /billing/checkout`** (`getOpenCheckout`, auth `account`): `OpenCheckout = { checkout:
  Checkout | null }`, the account's checkout in progress (`requires_setup`, `requires_payment` or
  `processing`, not expired) with its plan, promotion, `promotionOutcome`, state, trial and amount.
  Its `clientSecret` is always null; `GET /billing/checkout/:id` answers it to the session that
  continues.
- **`Checkout.promotionOutcome: "pending" | "applied" | "not_applied_trial" | null`** (behaviour
  change): a promo code is never spent on a payment of nothing. When the checkout grants a trial
  the code is neither applied nor redeemed (`not_applied_trial`, `promotion` still names it) and
  the trial converts at the full price; without a trial it applies to the first payment as before
  (`applied`). Null without a code; `pending` until the card is confirmed.
- **`PaymentMethodSetup.failureReason: DeclineReason | null`**: why a `failed` card change failed,
  in the words a checkout decline uses (`card_declined`, `insufficient_funds`, `expired_card`).
- Fake provider (local modes, not the contract): its form `/_pay/form` always leads back. With a
  `return` path a decline, a failed challenge or a payment that can no longer be made redirects
  to `return?payment=failed` (success: `payment=succeeded`), every page offers "Return to Webflix"
  (`payment=failed`), a declined card can be followed by another on the same page (as on
  Stripe's), and a second submission of something already confirmed redirects as succeeded.
- **Error `account_deletion_scheduled`** (409, "This account is being deleted"; detail "Your
  account is scheduled to be deleted. Keep your account first, then try again."): while the
  account's deletion is scheduled, `POST /account/subscription/resume`, `PUT
  /account/subscription`, `POST /billing/checkout` and `POST /billing/checkout/:id/confirm`
  (a checkout still `requires_setup`) refuse with it: the checkout routes for any account,
  resume and the plan change for a membership at the payment provider (milestone 1's mock
  membership charges nothing and is not guarded).
  Declared on those four routes (billing's route file: only their `errors` lists changed).
  `DELETE /account/deletion` lifts it at once. `DeletionMembership.status: renewing` stays for
  what staff or the provider cause meanwhile.

## 2026-11-23 — billing: the legacy card fields are gone (breaking for milestone 1's card body)

- **No route accepts card data** (principle 4, docs/BLUEPRINT-M2.md §5.6, §11.1).
  `packages/contracts/test/no-card-data.test.ts`'s `LEGACY_CARD_FIELDS` is empty, and
  `MockCardPayment`, `UpdatePaymentMethodBody` and `MOCK_CARDS` are removed.
  - `POST /auth/signup`: `SignupBody` is `{ email, password }`, **strict**. Milestone 1's
    `planId` + `payment` (or anything else) is refused with `400 validation_failed` (the issue
    names the keys, never their values) and creates nothing. `payment_declined` is no longer one of
    its errors. The account has no membership: the plan is chosen and paid at checkout.
  - `PUT /account/subscription` (`changePlan`): `ChangePlanBody` is `{ planId, previewToken? }`,
    **strict**: `payment` is refused with `validation_failed`. Every plan change now counts against
    the account's `payment` budget (route-level, no longer only when a card was sent).
  - `PUT /account/payment-method` (`updatePaymentMethod`) is **removed** (404): it existed only to
    take a simulated card, and nothing calls it; a card is replaced through
    `POST /billing/payment-method/setup` and the provider's form.
  - `DELETE /account/subscription` and `POST /account/subscription/resume` stay (no card fields).
    On milestone 1's simulated membership (the seeded demo account's) nothing is charged any more:
    a plan change is refused (`checkout_state_conflict`), cancel and undoing a cancel still work,
    restarting an ended one is refused (start a checkout).
- **`subscription` and `plan` are nullable** on `AuthenticatedSession` (`GET /session`, sign-up,
  sign-in, profile selection) and `AccountDetails` (`GET /account`): null when the account has no
  membership (`membership.status` `none`). The "ended Basic" stand-in is gone everywhere (the
  data export, the staff view, experiment targeting's plan, which is now null). `Membership`
  (the answer of a plan change, cancel or resume) stays non-null: those routes need a membership.
- **The only ways to become a member**: a checkout at the payment provider, the seeded demo
  account, or staff extending an existing membership. Milestone 1's mirror of a provider
  membership into the `subscriptions` row is gone (every reader uses the projection).
- **Clients**: the web reads `subscription` and `plan` as possibly null (smallest edits) and its
  mock mode answers null without a membership. The e2e helper `createAccount` and the
  conformance suite make members through a checkout at the fake provider; without the fake
  provider (production configuration) the checks that need a member skip with that reason. New
  conformance checks: `identity.signup.card-data-refused` (replacing
  `identity.signup.declined-cards`) and `plans.payment-budget` (replacing `plans.payment-method`).

## 2026-11-23 — identity: automatic linking needs ways in the address's owner set up (behaviour)

Security review H1 (pre-account takeover). No schema change; the routes answer as before.

- **A verification link opened outside the account's own session no longer enables automatic
  linking.** `POST /auth/email-verification/confirm` still verifies the address from any browser
  and still answers 204. Only when the request carries a live session of the token's own account
  does it also prove the account's ways in, and only then may a Google or Apple sign-in with that
  address link itself (§4.1). Otherwise such a sign-in answers `?oidc=link-required`.
- **What proves an account's ways in:** a federated sign-up with an issuer-verified address; a
  completed password reset; the verification link opened in a session of that account. Not a
  password change, a password sign-in, a deliberate link, or a verification click anywhere else.
  **An address change clears the proof** (the new address is verified and proven again).
- **Who now sees `link-required` where they were linked before:** a password account whose
  address was verified outside its own signed-in session (another device, signed out, an
  expired session, another account's session), and every account that existed before this
  change, unless it reset its password since. Those members sign in and link from Account, or
  reset the password.
- **Configuration:** `WEBFLIX_EMAIL_SENDER=outbox` is refused at startup in production on Node
  and on the Worker (review L4: it stores live reset and verification links). Development and
  test keep it (local Cloudflare, the Kubernetes conformance variant).

## 2026-11-23 — billing: per-account budgets for routes that call the provider (behaviour)

Security review M1. No new field; three routes gain `rate_limited` (429, `Retry-After`).

- **One promo-code budget, whichever route.** `POST /billing/checkout` with a `promotionCode`
  now spends the account's `promotion` budget (10/600 s), the one
  `POST /billing/promotions/validate` spends. The code the account's open checkout already
  carries is not charged again (a payment page picking its checkout up). A checkout without a
  code is not a lookup.
- **`billing`, 30/600 s per account**, on `POST /billing/checkout`,
  `POST /billing/subscription/preview` and `POST /billing/payment-method/setup` (each calls the
  provider). Refused with `rate_limited`; nothing is started or changed.
- **Polls are never refused.** `GET /billing/checkout/:id` and
  `GET /billing/payment-method/setup/:id` read the provider at most once per account every two
  seconds (`billing-refresh`); a poll in between answers from stored state, so an answer can
  trail the provider by up to two seconds (plus the poll interval). The client secret is stored
  with the checkout and the card change (migration 0021, `client_secret`, cleared once the
  browser no longer needs it), and a failed card change keeps its reason (`failure_reason`).
- **Clients**: the conformance suite's documented limits (`tools/smoke/src/limits.ts`) list
  both policies, strict and relaxed alike.

## 2026-11-23 — staff API: privacy review (M2, M5, M6, L9) and the audit log at a glance (UX 2.17)

All additive for a client of the previous contract (new response fields, a new query filter,
new constants); the behaviour changes are listed so the console and the conformance suite can
follow them.

- **`AuditLogEntry` gains** `kind` (`AUDIT_ENTRY_KINDS`: `action` | `read`), `targetLabel`
  (string | null: the target in words, resolved when the log is read and never stored: a
  member's current address, `ERASED_MEMBER_LABEL` "Erased member" for a target `erased:<id>`, a
  title's or collection's name; null where `target.id` reads well) and `facts` (`AuditFacts`:
  optional `amount` (Money), `planId`, `days`, `when`, `status`, `purpose`, `granted`,
  `available`, `titleCount`, `outcome`, `run`, `count`, `error`; only those that apply). In
  `GET /audit/mine`, `facts` is `{}` or `{ error }`, and a member target's label is null unless
  the caller holds `support` or `admin`.
- **`AuditQuery.kind`** (and `OwnAuditQuery.kind`): `action` leaves out the reads
  (`AUDIT_READ_ACTIONS`: `member.viewed`, `member.searched`, `member.privacy_viewed`,
  `audit.read`, `privacy.erasures_listed`, `privacy.exports_listed`); `read` lists only them.
- **`SystemHealth.privacy`** (new, required): `pendingErasures`, `oldestPendingErasureAt`,
  `oldestPendingErasureAgeSec`, `waitingExports`, `oldestWaitingExportAt`,
  `oldestWaitingExportAgeSec` (counts up to 500; ages in seconds; nulls when nothing waits).
- **Behaviour.**
  - `member.searched` keeps the query's shape only (`target.id` `j***@e***` for an address, the
    first three characters of anything else); migration `0023_admin_audit_privacy` masks the
    entries written before (first character) and drops the key lists of earlier erasure
    confirmations.
  - `privacy.erasures_confirmed` keeps `before.request: { keys: <count> }`, never the keys.
  - Reading `GET /audit` writes `audit.read` (`after: { filters, results }`); the operator
    lists write `privacy.erasures_listed` / `privacy.exports_listed` (`after: { count }`).
  - After a member's erasure their entries have `target.id` `erased:<id>` (one marker per
    member), `before`, `reason` and the idempotency key null, `after` null or `{ error }`; other
    entries naming them have each identifier replaced by the marker.
  - The data export's `areas.admin` is `{ staffAccess: [{ at, action }] }`, oldest first.
  - Entries older than `WEBFLIX_AUDIT_RETENTION_DAYS` (default 396) are deleted.
- **Constants**: `AUDIT_READ_ACTIONS`, `AUDIT_ENTRY_KINDS`, `ERASED_MEMBER_LABEL`.
- **Schemas**: `AuditFacts`.
- **What the conformance suite can assert**: a staff search by a full address leaves an entry
  whose `target.id` contains no `@`-address; `GET /audit` itself produces an `audit.read` entry;
  `GET /audit?kind=action` contains no entry of `AUDIT_READ_ACTIONS` and `kind=read` only those;
  a refund's entry has `facts.amount`; a member target's `targetLabel` is the member's address;
  `GET /system/health` has the six `privacy` fields; after `privacy.deletion.erasure`,
  `GET /audit?targetId=<the erased account id>` is empty while the staff member's entries of the
  same moments still exist with a target `erased:…` and `targetLabel` "Erased member"; the
  member's export (taken before deleting) has `areas.admin.staffAccess` items with exactly the
  keys `at` and `action`.

## 2026-11-23 — identity: a reset signs you in; an account with no profile manages itself

- **`POST /auth/password-reset/confirm` answers the session** (breaking for a reader of its
  response: it was `204` with no body). Now `200` with `AuthenticatedSession`, the session cookie
  and the known-device cookie, exactly as `POST /auth/login` does. Every other device is still
  signed out and identities linked under another address are still dropped; the device that
  completed the reset is the only one signed in, at the profile gate (`activeProfile` null).
  Show "you're signed in here, and signed out everywhere else" and continue as after sign-in.
  The web's mock handler (`apps/web/src/mocks/handlers.ts`, `confirmPasswordReset`) must now
  return the session.
- **An account with no profile at all is its own account holder at the profile gate**
  (behaviour; no schema change). The account-holder routes (`GET`/`PATCH /account`, devices,
  identities, privacy requests, export and deletion, billing's account routes, `POST
  /auth/logout-all`) answered `403 profile_required` for an account that never made a profile.
  They now answer as for a profile without parental controls, as long as the account has no
  profile. Each route's own proof still applies: `currentPassword` or a fresh proof for `PATCH
  /account`, a fresh proof for export and deletion. As soon as one profile exists (a kids one
  included), the gate answers `profile_required` again, as before.

## 2026-11-23 — events: the privacy review's fixes (additive, one rule tightened)

For the web privacy screens, the staff console and the conformance suite. No field is removed;
two are added as required (a client building these objects must add them).

- **`PrivacyRequest.email`** (required, nullable): `"pending" | "sent" | "suppressed" | null`.
  What the request's email did: an export's "ready" email, a deletion's "will be deleted" one.
  `pending`: it will be sent (an export when ready; a deletion's, queued after a delivery
  error); `sent`; `suppressed`: the address bounced or complained before, so none is or will
  be sent (privacy review L10); null: none (older requests).
- **A deletion's `status: processing`** now means the erasure has started: the account is
  locked (every session ended, no sign-in), it can no longer be kept, and it is retried until it
  finishes ("we're deleting your account"). `POST /account/deletion` answers
  `privacy_request_pending` and `DELETE /account/deletion` `not_found` meanwhile. An export's
  `pending`/`processing` is given up after a day (`failed`; ask again).
- **`POST /privacy/exports/:id/download`** (`fetchDataExport`, account holder): body
  `DataExportDownloadBody { token }`, answers `DataExport` as the GET does: the token never sits
  in a URL (L3). Both forms now need a fresh account-holder proof: `403
  reauthentication_required`, checked after the token (a foreign, expired or bad token stays
  `404 not_found`) (L2). The export email's landing page should call the POST form.
- **`pendingExports`' `from`** is `1970-01-01T00:00:00.000Z`: an export covers every event the
  lake still holds, never cut at the retention period (H1). The pipeline's `export-events`
  already lists every hour and filters by window.
- **Error `consent_grant_member_only`** (403, "Only the member can turn this on"; detail "Staff
  can only record a withdrawal. The member turns a purpose on themselves, in Account ›
  Privacy."): `PUT /api/admin/v1/members/:accountId/privacy/consent` with `granted: true`
  (declared on that staff route). A withdrawal is recorded as before (M4). A support grant
  recorded earlier is no longer the consent in force, so `ConsentState` shows the answer before
  it (or the mode's default) and `promptRequired` again where nothing else was answered.
- **`SystemHealth.privacy`** gains `erasuresInProgress`, `oldestErasureInProgressAt`,
  `oldestErasureInProgressAgeSec`: account erasures started and not finished; one whose age
  keeps growing is stuck (the events area's `staff.erasuresInProgress` says why).
- **Email templates** (`EMAIL_TEMPLATES`, `packages/email`): `account-deletion-scheduled`
  `{ scheduledFor, keepUrl }` and `account-deletion-canceled` `{ manageUrl }` (M7).
- **`DataExport.notes`** describe the `areas` parts present (identity, billing,
  personalisation's `recommendationLists`, admin's `staffAccess`) and say what is held but not
  included; the card note says what Webflix stores (brand, last four digits, expiry) (M6).
- **Schemas**: `DataExportDownloadBody`.

## 2026-11-23 — billing: trial eligibility and amounts with their reason (additive)

UX review 2.6, 2.3 and 2.2. Fields only; nothing removed. Migration 0026 (billing) stores the
amounts' reasons on invoices and checkouts.

- **`OpenCheckout.trialEligible: boolean`** (`GET /billing/checkout`, also when `checkout` is
  null): true until the account has had a trial (the plan's `trial` is then what it gets, unless
  the card it confirms already had a trial elsewhere: that checkout goes to `requires_payment`);
  false once it had one, and when no provider is configured.
- **`creditApplied: Money | null` and `discount: Money | null`** (null when zero) on
  `MembershipState.nextInvoice`, `Checkout` (beside `amountDue`), `PlanChangePreview` (beside
  `amountDue`), `PlanChangePreview.nextRenewal` and `Invoice`. Everywhere: the price before
  credit and discounts is `amount + creditApplied + discount` (a renewal or first payment: the
  plan's price; a plan change's `amountDue`: the new plan's remaining time, `creditApplied`
  being the current plan's unused time and any account credit).
- **`Checkout.amountDue` is known at `requires_setup`** for an account with `trialEligible`
  false: the provider previews the first invoice (the account's credit, the code), so a restart
  states "$3.01 today ($7.99 less your $4.98 credit)" before the provider's form. For an
  eligible account it stays null until the card is confirmed.
- **`Invoice.total` < 0** is documented as a credit to the account (a downgrade's unused time),
  not a payment: `amountPaid` is 0 and later invoices show it as `creditApplied`.
- **Port**: `PaymentProvider.previewFirstInvoice`; `ProviderInvoice`, `NextInvoicePreview` and
  `ProrationPreview` (and its `nextRenewal`) carry `creditAppliedMinor` and `discountMinor`.

## 2026-11-23 — billing: what an erasure keeps, the export, no cancellation email for a deletion (behaviour)

Privacy review M5, M6, M7. No route or field changes.

- **Erasure** keeps only invoices (without `hostedUrl`/`pdfUrl`) and refunds, and each card
  fingerprint that had a trial with no account and no time (docs/FOUNDATION.md D-M2-6). The fake
  provider follows: the customer becomes a stub naming no one; its cards, setups, event log,
  test clock and idempotency records go; invoices lose their client secrets.
- **Provider events naming a customer that is no one's** (an erased account's, another
  deployment's on a shared provider account) are acknowledged (`duplicate: false`) and not
  stored; reconciliation skips them the same way.
- **Data export** (`areas.billing`) adds `checkouts` (the `Checkout` shape, `clientSecret` always
  null), `promotionCodes` (`code`, `checkoutId`, `outcome`, `at`) and `cardChanges` (the
  `PaymentMethodSetup` shape, `clientSecret` null).
- **No `cancellation` email when the account's deletion is scheduled** (the request's own cancel,
  the sweep's retry, a staff cancel meanwhile). An ordinary cancel still sends it.
