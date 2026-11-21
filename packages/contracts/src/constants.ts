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
export const SEARCH_QUERY_MAX_LENGTH = 100;

// --- Library ----------------------------------------------------------------------------------
export const NOTIFICATION_KINDS = ["new-arrival", "new-episodes", "coming-soon", "top-10"] as const;

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
