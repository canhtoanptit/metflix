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
