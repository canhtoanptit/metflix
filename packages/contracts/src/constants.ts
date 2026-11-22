/**
 * Contract constants. This module (like `http.ts`, `error-codes.ts`, `route.ts`,
 * `route-index.gen.ts`, `media-helpers.ts` and `client.ts`) must not import zod at runtime,
 * so the web app's initial bundle can use the client, the helpers and these values without
 * shipping zod. Schemas build their enums from these tuples. Enforced by `test/zod-free.test.ts`.
 */
import type { ProfileSettings } from "./profiles.ts";

// --- Pagination -------------------------------------------------------------------------------
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// --- Maturity (ordered; the tuple order IS the ordering) --------------------------------------
export const MATURITY_LEVELS = ["ALL", "7+", "13+", "16+", "18+"] as const;
/** Default ceiling for a kids profile. */
export const KIDS_MATURITY_CEILING: (typeof MATURITY_LEVELS)[number] = "7+";
/** Default ceiling for a regular profile. */
export const DEFAULT_MATURITY_CEILING: (typeof MATURITY_LEVELS)[number] = "18+";

// --- Plans ------------------------------------------------------------------------------------
export const PLAN_IDS = ["basic", "standard", "premium"] as const;
export const VIDEO_QUALITIES = ["720p", "1080p", "2160p"] as const;

// --- Account ----------------------------------------------------------------------------------
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
/**
 * Longest password in UTF-8 bytes after NFKC normalisation (what the hasher sees): 128
 * characters can expand far beyond it (U+FDFA becomes 18 characters).
 */
export const PASSWORD_MAX_BYTES = 1024;
/**
 * `active`: paid up. `canceling`: canceled but usable until `currentPeriodEnd`.
 * `ended`: no access to playback (`subscription_required`); can be resumed.
 */
export const SUBSCRIPTION_STATUSES = ["active", "canceling", "ended"] as const;
export const CARD_BRANDS = ["visa", "mastercard", "amex", "discover", "other"] as const;
export const DEVICE_TYPES = ["desktop", "mobile", "tablet", "tv", "unknown"] as const;
/**
 * `payment_declined.declineReason`. Milestone 2's billing owner extends this with what a real
 * provider also reports (docs/STRIPE.md §7) together with the web checkout, whose copy switches
 * exhaustively on it. Never show a provider's own message to a member.
 */
export const PAYMENT_DECLINE_REASONS = [
  "card_declined",
  "insufficient_funds",
  "expired_card",
] as const;
/** Test cards understood by the mock billing provider. Any other valid number is approved. */
export const MOCK_CARDS = {
  approved: "4242424242424242",
  declined: "4000000000000002",
  insufficientFunds: "4000000000009995",
} as const;

// --- Profiles ---------------------------------------------------------------------------------
export const MAX_PROFILES_PER_ACCOUNT = 5;
export const PROFILE_NAME_MAX_LENGTH = 30;
export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  autoplayNextEpisode: true,
  autoplayPreviews: true,
  subtitleLanguage: null,
};

// --- Titles -----------------------------------------------------------------------------------
export const TITLE_TYPES = ["movie", "series"] as const;
export const RATING_VALUES = ["dislike", "like", "love"] as const;
/** The single most important badge to show on a card, chosen by the server. */
export const TITLE_BADGES = ["new", "new-episodes", "top-10", "leaving-soon"] as const;
/**
 * Top 10 badges one list of cards carries at most (a row, a genre page, search results); none in
 * Continue Watching or the ranked row. Chosen by the server (docs/RECOMMENDATIONS.md, Badges).
 */
export const TOP_10_BADGES_PER_LIST = 2;
/**
 * Badges of any kind one list of cards carries at most (a row, a genre page, search results):
 * a badge is the exception. The Top 10 row and Continue Watching follow their own, stricter
 * rules (docs/RECOMMENDATIONS.md, Badges).
 */
export const BADGES_PER_LIST = 2;

// --- Browse -----------------------------------------------------------------------------------
export const BROWSE_VIEWS = ["home", "series", "movies", "new-popular"] as const;
/**
 * Why a row exists. Informational (analytics, test ids, empty-state copy): the web must
 * render rows from `layout` and the items alone, never by switching on `kind`.
 */
export const ROW_KINDS = [
  "continue-watching",
  "my-list",
  "top-10",
  "trending",
  "new-releases",
  "because-you-watched",
  "genre",
  "watch-again",
  "originals",
  // Milestone 2: the learned "Top Picks" row (docs/BLUEPRINT-M2.md §7.2).
  "top-picks",
  // Milestone 2: a curated collection staff publish on a view (§8.3, editorial rows).
  "collection",
] as const;
/**
 * How a row is drawn. The item shape is determined by the layout:
 * - `standard`: landscape title cards.
 * - `tall`: portrait poster cards (e.g. Originals).
 * - `ranked`: portrait posters with oversized rank numerals (Top 10).
 * - `continue`: landscape cards with a progress bar and the episode to resume.
 */
export const ROW_LAYOUTS = ["standard", "tall", "ranked", "continue"] as const;
export type RowLayout = (typeof ROW_LAYOUTS)[number];
export const GENRE_SORTS = ["suggested", "newest", "oldest", "a-z", "z-a"] as const;
/** Characters of a query that are searched; a longer query is cut there (between code points). */
export const SEARCH_QUERY_MAX_LENGTH = 100;
/** Longest query accepted at all (`validation_failed` beyond): what a search field never sends. */
export const SEARCH_QUERY_INPUT_MAX_LENGTH = 2000;

// --- Library ----------------------------------------------------------------------------------
export const NOTIFICATION_KINDS = ["new-arrival", "new-episodes", "coming-soon", "top-10"] as const;

// --- Previews ---------------------------------------------------------------------------------
/**
 * What a preview clip is: `footage` (a cut of the title itself) or `motion` (motion art rendered
 * from the title's key art, no footage).
 */
export const PREVIEW_KINDS = ["footage", "motion"] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

// --- Playback ---------------------------------------------------------------------------------
export const TEXT_TRACK_KINDS = ["subtitles", "captions"] as const;
export const PLAYBACK_STATES = ["playing", "paused", "buffering", "ended"] as const;

// --- Media ------------------------------------------------------------------------------------
export const IMAGE_FORMATS = ["avif", "webp"] as const;
/** Kinds of artwork generated per title (blueprint §2.5, §7). */
export const TITLE_IMAGE_KINDS = ["backdrop", "card", "poster", "logo"] as const;
export type TitleImageKind = (typeof TITLE_IMAGE_KINDS)[number];
/** Placeholders that every image URL template contains. */
export const IMAGE_TEMPLATE_WIDTH = "{width}";
export const IMAGE_TEMPLATE_FORMAT = "{format}";
export const MEDIA_MANIFEST_VERSION = 1;
export const MEDIA_PROFILES = ["fast", "full"] as const;

// --- Video quality ----------------------------------------------------------------------------
/**
 * Video quality tiers, lowest first (the tuple order IS the ordering). A rendition's tier comes
 * from its nominal height, the height of the 16:9 frame it fills (`nominalVideoHeight`), so a
 * 1920×800 scope encode is Full HD like 1920×1080. Labels and thresholds live here so the
 * server, the web app and the conformance suite say the same thing.
 */
export const VIDEO_QUALITY_TIERS = ["sd", "hd", "full-hd", "4k"] as const;
/** Lowest nominal height of each tier: 720 is HD, 1080 Full HD, 2160 4K; anything less is SD. */
export const VIDEO_QUALITY_MIN_HEIGHT: Readonly<
  Record<(typeof VIDEO_QUALITY_TIERS)[number], number>
> = { sd: 0, hd: 720, "full-hd": 1080, "4k": 2160 };
/** What badges and the player print for each tier. */
export const VIDEO_QUALITY_LABELS: Readonly<Record<(typeof VIDEO_QUALITY_TIERS)[number], string>> =
  { sd: "SD", hd: "HD", "full-hd": "Full HD", "4k": "4K" };

// --- Marketing --------------------------------------------------------------------------------
/** Titles `GET /showcase` returns at most (enough for a poster wall without visible repeats). */
export const SHOWCASE_SIZE = 40;
/** The showcase never includes a title rated above this. */
export const SHOWCASE_MATURITY_CEILING: (typeof MATURITY_LEVELS)[number] = "13+";

// --- Seeds ------------------------------------------------------------------------------------
export const SEED_VERSION = 1;
export const DEMO_ACCOUNT_EMAIL = "demo@webflix.dev";
export const DEMO_ACCOUNT_PASSWORD = "webflix-demo";

// =============================================================================================
// Milestone 2 (docs/BLUEPRINT-M2.md). Everything the web app, the telemetry SDK or the admin
// console needs at runtime lives here, zod-free.
// =============================================================================================

// --- Identity (§4) ----------------------------------------------------------------------------
/**
 * Consumer OpenID issuers. Each has the fixed callback `/api/v1/auth/oidc/{provider}/callback`
 * (packages/dev-idp/README.md); which ones a deployment offers is configuration.
 */
export const OIDC_PROVIDERS = ["google", "apple", "keycloak"] as const;
export type OidcProvider = (typeof OIDC_PROVIDERS)[number];
/**
 * Why a federated sign-in starts: sign in or sign up (`signin`), attach the issuer to the
 * signed-in account (`link`), or prove it is the account holder with a fresh sign-in
 * (`reauth`, §4.2: `max_age=0`).
 */
export const OIDC_INTENTS = ["signin", "link", "reauth"] as const;
export type OidcIntent = (typeof OIDC_INTENTS)[number];
/**
 * Where a federated sign-in ended. The callback redirects the browser to its `returnTo` path
 * with `?oidc=<outcome>` (`OIDC_RESULT_PARAM`):
 * - `signed-in`, `signed-up` (a new account, membership `none`), `linked`, `reauthenticated`;
 * - `link-required`: an account has this email but it may not be linked automatically
 *   (unverified on either side, §4.1): sign in to it first, then link from Account;
 * - `identity-in-use`: this issuer identity already belongs to another account;
 * - `cancelled`: the member cancelled at the issuer;
 * - `failed`: anything else (an invalid response, an unavailable issuer). Never more detail
 *   in the URL; the server logs why.
 */
export const OIDC_OUTCOMES = [
  "signed-in",
  "signed-up",
  "linked",
  "reauthenticated",
  "link-required",
  "identity-in-use",
  "cancelled",
  "failed",
] as const;
export type OidcOutcome = (typeof OIDC_OUTCOMES)[number];
export const OIDC_RESULT_PARAM = "oidc";
/** Ways to prove it is the account holder (§4.2). */
export const REAUTH_METHODS = ["password", ...OIDC_PROVIDERS] as const;
/** How long a proof of being the account holder lasts (`sessions.elevated_until`, §4.2). */
export const ELEVATION_TTL_SEC = 5 * 60;
/** Single-use email links (§4.3). */
export const EMAIL_VERIFICATION_TTL_SEC = 24 * 60 * 60;
export const PASSWORD_RESET_TTL_SEC = 30 * 60;

// --- Billing (§5) -----------------------------------------------------------------------------
/** Payment providers behind the `PaymentProvider` port (§5.5). */
export const PAYMENT_PROVIDERS = ["stripe", "fake"] as const;
/**
 * The membership projection (§5.2). Entitled to play: `trialing`, `active`, and `past_due`
 * during grace. "Cancelling" is not a state: see `Membership.cancelAtPeriodEnd`.
 */
export const MEMBERSHIP_STATUSES = [
  "none",
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "suspended",
  "canceled",
] as const;
/** Why a membership is `suspended` (docs/STRIPE.md §9). */
export const SUSPENDED_REASONS = ["grace_expired", "unpaid", "paused"] as const;
/** Why the account may not play (`Entitlement.reason`), or `entitled`. */
export const ENTITLEMENT_REASONS = [
  "entitled",
  "no_membership",
  "payment_pending",
  "suspended",
  "ended",
] as const;
/** The 7-day trial of every plan (§1: approved default). */
export const TRIAL_DAYS = 7;
/**
 * Where a checkout stands (§5.1, §5.4 two-step flow):
 * - `requires_setup`: the browser confirms the card with the provider's form (`clientSecret`);
 * - `requires_payment`: not eligible for a trial (or a restart): the browser confirms the first
 *   payment (`clientSecret`), including any 3-D Secure challenge;
 * - `processing`: confirmed; waiting for the provider's event to activate the membership;
 * - `complete`: the membership is `trialing` or `active`;
 * - `failed`, `expired`: start a new checkout.
 */
export const CHECKOUT_STATUSES = [
  "requires_setup",
  "requires_payment",
  "processing",
  "complete",
  "failed",
  "expired",
] as const;
export const INVOICE_STATUSES = ["draft", "open", "paid", "void", "uncollectible"] as const;
/** Why a promo code cannot be used (§5.4: read before applying; never parse provider messages). */
export const PROMOTION_FAILURE_REASONS = [
  "unknown",
  "expired",
  "exhausted",
  "not_applicable",
  "already_redeemed",
] as const;
export const PAYMENT_METHOD_SETUP_STATUSES = [
  "requires_confirmation",
  "processing",
  "succeeded",
  "failed",
] as const;

// --- Behaviour events (§6) --------------------------------------------------------------------
/**
 * Event types (dotted names, services/recs/README.md decision 8). Client events come from the
 * telemetry SDK through `POST /events`; server events are emitted by services and never
 * accepted over HTTP.
 */
export const CLIENT_EVENT_TYPES = [
  "impression",
  "row.view",
  "title.open",
  "preview.start",
  "preview.complete",
  "search.query",
  "search.click",
  "list.add",
  "list.remove",
  "rating.set",
  "rating.clear",
  "signup.step",
  "client.error",
] as const;
export const SERVER_EVENT_TYPES = [
  "playback.start",
  "playback.progress",
  "playback.complete",
  "playback.abandon",
  "billing.transition",
  "auth.signin",
  "auth.signup",
  "experiment.exposure",
  "consent.change",
] as const;
export const EVENT_TYPES = [...CLIENT_EVENT_TYPES, ...SERVER_EVENT_TYPES] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];
export type EventType = (typeof EVENT_TYPES)[number];
/** Payload schema version of every type today; a new optional field is a new version. */
export const EVENT_VERSION = 1;
export const EVENT_SOURCES = ["client", "server"] as const;
export const CLIENT_PLATFORMS = ["web", "ios", "android", "tv"] as const;
export const EVENT_PLATFORMS = [...CLIENT_PLATFORMS, "server"] as const;
/** Where in the product a client event happened (`context.surface`). */
export const EVENT_SURFACES = [
  "home",
  "series",
  "movies",
  "new-popular",
  "genre",
  "search",
  "title-detail",
  "my-list",
  "player",
  "account",
  "signup",
  "landing",
] as const;
/** `row.view.rowKind`: the engine's row kinds plus the billboard. */
export const EVENT_ROW_KINDS = ["billboard", ...ROW_KINDS] as const;
export const SIGNUP_STEPS = ["email", "plan", "payment", "profiles", "complete"] as const;
export const SIGNUP_STEP_OUTCOMES = ["viewed", "completed", "failed"] as const;
export const PLAYBACK_ABANDON_REASONS = ["closed", "error", "stalled", "replaced"] as const;
export const AUTH_EVENT_METHODS = ["password", "oidc"] as const;
export const AUTH_EVENT_OUTCOMES = ["success", "failure"] as const;
export const EXPERIMENT_UNIT_TYPES = ["profile", "device"] as const;
/** `POST /events` limits (§6.2). */
export const EVENT_BATCH_MAX_EVENTS = 50;
export const EVENT_BATCH_MAX_BYTES = 64 * 1024;
/** Lake objects (§6.2): `events/dt=YYYY-MM-DD/hh=HH/{uuid}.ndjson.gz`, by receipt hour. */
export const EVENT_LAKE_PREFIX = "events/";

// --- Privacy (§6.3) ---------------------------------------------------------------------------
export const CONSENT_PURPOSES = ["analytics", "personalisation"] as const;
export const CONSENT_SOURCES = ["banner", "settings", "gpc", "support"] as const;
/** Deployment-wide consent regime: ask first, assume until withdrawn, or no collection. */
export const CONSENT_MODES = ["opt-in", "opt-out", "off"] as const;
export const PRIVACY_REQUEST_KINDS = ["export", "deletion"] as const;
export const PRIVACY_REQUEST_STATUSES = [
  "pending",
  "scheduled",
  "processing",
  "completed",
  "canceled",
  "failed",
] as const;

// --- Experiments (§8.1) -----------------------------------------------------------------------
export const EXPERIMENT_STATUSES = ["draft", "running", "paused", "completed", "archived"] as const;
/** Metrics the analysis job computes (services/recs schemas/experiment-definitions). */
export const EXPERIMENT_METRICS = [
  "qualified_plays",
  "watch_hours",
  "any_play",
  "active_days",
  "retained",
] as const;
export const EXPERIMENT_AUDIENCES = ["all", "new", "existing"] as const;
/** Allocation unit within a layer: basis points, [0, 10000). */
export const EXPERIMENT_BUCKETS = 10_000;

// --- Staff (§8.3) -----------------------------------------------------------------------------
export const STAFF_ROLES = ["support", "billing", "content", "experiments", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
/** The staff console's OpenID client and the admin API's audience (packages/dev-idp). */
export const STAFF_CLIENT_ID = "webflix-admin";
export const STAFF_API_AUDIENCE = "webflix-admin-api";
export const AUDIT_ACTOR_TYPES = ["staff", "member", "system"] as const;

// --- Email (§8.2) -----------------------------------------------------------------------------
export const EMAIL_TEMPLATES = [
  "verify-email",
  "reset-password",
  "welcome",
  "receipt",
  "payment-failed",
  "trial-ending",
  "plan-changed",
  "cancellation",
  "new-sign-in",
  "security-change",
  "data-export-ready",
] as const;
export const EMAIL_SUPPRESSION_REASONS = ["bounce", "complaint", "manual"] as const;
