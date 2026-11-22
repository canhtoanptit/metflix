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
