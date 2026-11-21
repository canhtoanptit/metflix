/**
 * Track selection rules: which subtitle track to show for a preference, how audio tracks are
 * labelled, and which renditions the quality menu offers under the plan's height cap.
 */
import {
  effectiveVideoQuality,
  nominalVideoHeight,
  type PlaybackSession,
  type TextTrack,
  videoQualityForHeight,
  videoQualityLabel,
} from "@webflix/contracts";

/** Primary language subtag, lower-cased: "pt-BR" → "pt". */
export function primaryLanguage(tag: string): string {
  return tag.split("-")[0]?.toLowerCase() ?? "";
}

function matchLanguage<T extends { language: string }>(items: readonly T[], tag: string): T[] {
  const exact = items.filter((item) => item.language.toLowerCase() === tag.toLowerCase());
  if (exact.length > 0) return exact;
  const primary = primaryLanguage(tag);
  return items.filter((item) => primaryLanguage(item.language) === primary);
}

/**
 * Subtitle track to show.
 * - A language preference picks the full (non-forced) track in that language when one exists.
 * - Subtitles off (`null`), or no track in the preferred language, still shows a forced track
 *   matching the audio language: forced narratives translate foreign dialogue everyone needs.
 * - No preference (`undefined`) uses the session's default track.
 */
export function selectTextTrack(
  tracks: readonly TextTrack[],
  preference: string | null | undefined,
  audioLanguage: string | null,
): TextTrack | null {
  if (typeof preference === "string") {
    const match = matchLanguage(
      tracks.filter((track) => !track.forced),
      preference,
    )[0];
    if (match) return match;
  }
  if (preference === undefined) {
    const fallback = tracks.find((track) => track.default && !track.forced);
    if (fallback) return fallback;
  }
  if (audioLanguage) {
    const forced = matchLanguage(
      tracks.filter((track) => track.forced),
      audioLanguage,
    )[0];
    if (forced) return forced;
  }
  return null;
}

/** Tracks the subtitles menu lists: forced tracks are automatic, never a menu choice. */
export function menuTextTracks(tracks: readonly TextTrack[]): TextTrack[] {
  return tracks.filter((track) => !track.forced);
}

/** Human label for a language tag in the viewer's locale, falling back to the tag. */
export function languageLabel(tag: string, locale?: string): string {
  if (!tag) return "";
  try {
    const names = new Intl.DisplayNames(locale ? [locale] : undefined, { type: "language" });
    const name = names.of(tag);
    if (name && name !== tag) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    // Invalid tag or no Intl.DisplayNames: show the tag.
  }
  return tag;
}

export interface QualityLevel {
  /** Engine level index (stable for the lifetime of a source). */
  id: number;
  width: number;
  height: number;
  bitrate: number;
}

export interface QualityOption extends QualityLevel {
  label: string;
  /** The shared quality vocabulary: "SD", "HD", "Full HD" or "4K". */
  badge: string;
}

export function qualityLabel(height: number): string {
  return `${height}p`;
}

/**
 * A rendition's quality in the contract's shared vocabulary (cards, details and the player
 * agree). Judged on the nominal 16:9 height, so a 1280×536 scope rendition counts as 720 (HD).
 */
export function qualityBadge(level: { width: number; height: number }): string {
  return videoQualityLabel(videoQualityForHeight(nominalVideoHeight(level.width, level.height)));
}

/**
 * The quality a whole session is in, for a session-level label: the lower of the title's best
 * packaged quality and the plan's cap. Null for external media (quality unknown).
 */
export function sessionQualityLabel(
  session: Partial<Pick<PlaybackSession, "bestVideoQuality">> &
    Pick<PlaybackSession, "maxVideoHeight">,
): string | null {
  const tier = effectiveVideoQuality(session.bestVideoQuality, session.maxVideoHeight);
  return tier ? videoQualityLabel(tier) : null;
}

/**
 * Menu options: renditions within the plan cap, tallest first, one entry per height (the
 * highest bitrate wins when a ladder has several at the same height).
 */
export function qualityOptions(
  levels: readonly QualityLevel[],
  maxVideoHeight: number,
): QualityOption[] {
  const byHeight = new Map<number, QualityLevel>();
  for (const level of levels) {
    if (level.height <= 0 || level.height > maxVideoHeight) continue;
    const current = byHeight.get(level.height);
    if (!current || level.bitrate > current.bitrate) byHeight.set(level.height, level);
  }
  return [...byHeight.values()]
    .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate)
    .map((level) => ({
      ...level,
      label: qualityLabel(level.height),
      badge: qualityBadge(level),
    }));
}

/**
 * Indexes of levels above the cap, highest index first (safe removal order). Never removes
 * every level: if all exceed the cap, the lowest one is kept so something still plays.
 */
export function levelsAboveCap(
  levels: readonly { height: number }[],
  maxVideoHeight: number,
): number[] {
  const over = levels
    .map((level, index) => ({ index, over: level.height > maxVideoHeight }))
    .filter((entry) => entry.over)
    .map((entry) => entry.index);
  if (over.length === levels.length && levels.length > 0) {
    let lowest = 0;
    levels.forEach((level, index) => {
      if (level.height < (levels[lowest]?.height ?? Number.POSITIVE_INFINITY)) lowest = index;
    });
    return over.filter((index) => index !== lowest).sort((a, b) => b - a);
  }
  return over.sort((a, b) => b - a);
}
