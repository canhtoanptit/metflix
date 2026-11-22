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
