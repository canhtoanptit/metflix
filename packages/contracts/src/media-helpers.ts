/**
 * Media URL helpers: responsive images, the blob layout (blueprint §2.5), protected media
 * paths and trick-play tiles. Zod-free at runtime (see `constants.ts`).
 */
import {
  type IMAGE_FORMATS,
  IMAGE_TEMPLATE_FORMAT,
  IMAGE_TEMPLATE_WIDTH,
  type TitleImageKind,
  VIDEO_QUALITY_LABELS,
  VIDEO_QUALITY_MIN_HEIGHT,
  VIDEO_QUALITY_TIERS,
} from "./constants.ts";
import { CDN_PATH_PREFIX, MEDIA_PATH_PREFIX } from "./http.ts";
import type { ImageSet } from "./media.ts";
import type { TrickPlay } from "./playback.ts";

type Format = (typeof IMAGE_FORMATS)[number];
type QualityTier = (typeof VIDEO_QUALITY_TIERS)[number];

/** Fill a `{width}`/`{format}` template (image URL or blob key) for one variant. */
export function fillImageTemplate(template: string, width: number, format: Format): string {
  return template
    .replaceAll(IMAGE_TEMPLATE_WIDTH, String(width))
    .replaceAll(IMAGE_TEMPLATE_FORMAT, format);
}

/** URL of one variant. `width` must be one of `set.widths`. */
export function imageUrl(set: ImageSet, width: number, format: Format): string {
  return fillImageTemplate(set.template, width, format);
}

/** `srcset` attribute value for one format, e.g. for `<source type="image/avif" srcset=...>`. */
export function imageSrcSet(set: ImageSet, format: Format): string {
  return set.widths.map((width) => `${imageUrl(set, width, format)} ${width}w`).join(", ");
}

/** Smallest available width that covers `cssWidth * devicePixelRatio`, else the largest. */
export function pickImageWidth(set: ImageSet, cssWidth: number, devicePixelRatio = 1): number {
  const needed = cssWidth * devicePixelRatio;
  const largest = set.widths[set.widths.length - 1] ?? 0;
  return set.widths.find((width) => width >= needed) ?? largest;
}

// --- Blob layout ------------------------------------------------------------------------------
//
// One bucket. Keys under `public/` are served at `/cdn/*` with immutable caching; keys under
// `vod/` are served only through signed `/media/{token}/vod/*` URLs. Both the media pipeline
// (writer) and the API (reader) build keys with these helpers so the layout lives in one place.

export const PUBLIC_BLOB_PREFIX = "public/";
export const VOD_BLOB_PREFIX = "vod/";

export const blobKeys = {
  /** Template with `{width}`/`{format}`: `public/img/titles/{titleId}/{kind}-{width}.{format}`. */
  titleImageTemplate: (titleId: string, kind: TitleImageKind) =>
    `${PUBLIC_BLOB_PREFIX}img/titles/${titleId}/${kind}-${IMAGE_TEMPLATE_WIDTH}.${IMAGE_TEMPLATE_FORMAT}`,
  /** Template for an episode still: `public/img/episodes/{episodeId}/still-{width}.{format}`. */
  episodeStillTemplate: (episodeId: string) =>
    `${PUBLIC_BLOB_PREFIX}img/episodes/${episodeId}/still-${IMAGE_TEMPLATE_WIDTH}.${IMAGE_TEMPLATE_FORMAT}`,
  avatar: (avatarId: string) => `${PUBLIC_BLOB_PREFIX}img/avatars/${avatarId}.webp`,
  preview: (assetId: string) => `${PUBLIC_BLOB_PREFIX}previews/${assetId}/preview.mp4`,
  /** Prefix that holds every file of one packaged asset (playlists, segments, subs, trick-play). */
  vodPrefix: (assetId: string) => `${VOD_BLOB_PREFIX}${assetId}/`,
  vodMaster: (assetId: string) => `${VOD_BLOB_PREFIX}${assetId}/master.m3u8`,
} as const;

/** `public/x` → `/cdn/x`. Works on templates too. Throws for non-public keys. */
export function cdnUrlForBlobKey(key: string): string {
  if (!key.startsWith(PUBLIC_BLOB_PREFIX)) {
    throw new Error(`Blob key is not public: ${key}`);
  }
  return `${CDN_PATH_PREFIX}/${key.slice(PUBLIC_BLOB_PREFIX.length)}`;
}

/** Longest blob key, in UTF-8 bytes (S3 and R2 both allow 1024). */
export const MAX_BLOB_KEY_BYTES = 1024;

/**
 * Why `key` is not a valid blob key, or null when it is. One rule set for the stores (which
 * refuse such keys) and the path parsers (which answer 404 rather than reach a store with one):
 * non-empty, at most 1024 UTF-8 bytes, no leading or trailing slash, no backslash or control
 * character, no empty, `.` or `..` segment.
 */
export function blobKeyProblem(key: string): string | null {
  if (key.length === 0) return "empty";
  if (new TextEncoder().encode(key).byteLength > MAX_BLOB_KEY_BYTES) return "too long";
  if (key.startsWith("/") || key.endsWith("/")) return "leading or trailing slash";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (/[\\\u0000-\u001f\u007f]/.test(key)) return "backslash or control character";
  if (key.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "empty, '.' or '..' segment";
  }
  return null;
}

/**
 * `/cdn/x` → `public/x`, or null if the path is not under the CDN prefix or would not be a
 * valid key (`blobKeyProblem`): answer those with 404, never reach a store with them (500).
 */
export function blobKeyForCdnPath(path: string): string | null {
  const prefix = `${CDN_PATH_PREFIX}/`;
  if (!path.startsWith(prefix)) return null;
  const key = `${PUBLIC_BLOB_PREFIX}${path.slice(prefix.length)}`;
  return blobKeyProblem(key) === null ? key : null;
}

/** `vod/{assetId}/...` → `/media/{token}/vod/{assetId}/...`. Throws for non-vod keys. */
export function mediaUrlForBlobKey(token: string, key: string): string {
  if (!key.startsWith(VOD_BLOB_PREFIX)) {
    throw new Error(`Blob key is not a vod key: ${key}`);
  }
  return `${MEDIA_PATH_PREFIX}/${encodeURIComponent(token)}/${key}`;
}

/**
 * Parse a protected media path `/media/{token}/vod/{assetId}/{rest}`.
 * Returns null for anything else, including attempts at path traversal.
 */
export function parseMediaPath(
  path: string,
): { token: string; assetId: string; key: string } | null {
  const match = /^\/media\/([^/]+)\/vod\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/(.+)$/.exec(path);
  if (!match) return null;
  const [, rawToken, assetId, rest] = match;
  if (rawToken === undefined || assetId === undefined || rest === undefined) return null;
  const key = `${VOD_BLOB_PREFIX}${assetId}/${rest}`;
  if (blobKeyProblem(key) !== null) return null;
  let token: string;
  try {
    token = decodeURIComponent(rawToken);
  } catch {
    return null;
  }
  return { token, assetId, key };
}

/**
 * Locate the trick-play tile for a media position (see `TrickPlay` for the sheet layout).
 * Returns null when no thumbnail exists.
 */
export function trickPlayTile(
  trickPlay: TrickPlay,
  positionSec: number,
): { sheetUrl: string; x: number; y: number; width: number; height: number } | null {
  if (trickPlay.count === 0 || positionSec < 0) return null;
  const index = Math.min(Math.floor(positionSec / trickPlay.intervalSec), trickPlay.count - 1);
  const perSheet = trickPlay.columns * trickPlay.rows;
  const sheetUrl = trickPlay.sheets[Math.floor(index / perSheet)];
  if (sheetUrl === undefined) return null;
  const cell = index % perSheet;
  return {
    sheetUrl,
    x: (cell % trickPlay.columns) * trickPlay.tileWidth,
    y: Math.floor(cell / trickPlay.columns) * trickPlay.tileHeight,
    width: trickPlay.tileWidth,
    height: trickPlay.tileHeight,
  };
}

// --- Video quality ----------------------------------------------------------------------------

/**
 * Height of the 16:9 frame a rendition fills, which is what "720p" or "1080p" name: 1920×800 →
 * 1080, 1280×536 → 720, 1440×1080 → 1080.
 */
export function nominalVideoHeight(width: number, height: number): number {
  return Math.max(height, Math.round((width * 9) / 16));
}

/** The quality tier of a nominal height (thresholds: `VIDEO_QUALITY_MIN_HEIGHT`). */
export function videoQualityForHeight(nominalHeight: number): QualityTier {
  let tier: QualityTier = "sd";
  for (const candidate of VIDEO_QUALITY_TIERS) {
    if (nominalHeight >= VIDEO_QUALITY_MIN_HEIGHT[candidate]) tier = candidate;
  }
  return tier;
}

/**
 * The quality a member actually gets: the lower of the title's best quality
 * (`TitleCard.bestVideoQuality`, `PlaybackSession.bestVideoQuality`) and the plan's cap
 * (`Plan.maxVideoHeight`, `PlaybackSession.maxVideoHeight`). Null when the title's quality is
 * unknown (external fallback media): show nothing rather than guess.
 */
export function effectiveVideoQuality(
  best: QualityTier | null | undefined,
  planMaxVideoHeight: number,
): QualityTier | null {
  if (!best) return null;
  const cap = videoQualityForHeight(planMaxVideoHeight);
  return VIDEO_QUALITY_TIERS.indexOf(best) <= VIDEO_QUALITY_TIERS.indexOf(cap) ? best : cap;
}

/** "SD", "HD", "Full HD" or "4K". */
export function videoQualityLabel(tier: QualityTier): string {
  return VIDEO_QUALITY_LABELS[tier];
}
