import {
  type BrowseView,
  effectiveVideoQuality,
  type MATURITY_LEVELS,
  type Plan,
  type Progress,
  type TitleCard,
  videoQualityLabel,
} from "@webflix/contracts";

/** "1h 52m", "47m", "45s" (runtimes and remaining time). */
export function formatRuntime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Spoken form for screen readers: "1 hour 52 minutes". */
export function formatRuntimeLong(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (rest > 0) parts.push(`${rest} minute${rest === 1 ? "" : "s"}`);
  return parts.join(" ");
}

export function formatSeasons(count: number): string {
  return `${count} Season${count === 1 ? "" : "s"}`;
}

/** Runtime for movies, season count for series (what cards and previews show). */
export function formatLength(card: Pick<TitleCard, "type" | "runtimeSec" | "seasonCount">): string {
  if (card.type === "series") return formatSeasons(card.seasonCount ?? 1);
  return card.runtimeSec ? formatRuntime(card.runtimeSec) : "";
}

/** "23 of 47m" — position against duration, for resume affordances. */
export function formatProgress(progress: Pick<Progress, "positionSec" | "durationSec">): string {
  const watched = Math.round(progress.positionSec / 60);
  const total = Math.max(1, Math.round(progress.durationSec / 60));
  return `${Math.min(watched, total)} of ${total}m`;
}

export function progressFraction(
  progress: Pick<Progress, "positionSec" | "durationSec"> | null | undefined,
): number {
  if (!progress || progress.durationSec <= 0) return 0;
  return Math.min(1, Math.max(0, progress.positionSec / progress.durationSec));
}

/** "S2:E3" */
export function episodeCode(episode: { seasonNumber: number; number: number }): string {
  return `S${episode.seasonNumber}:E${episode.number}`;
}

type Maturity = (typeof MATURITY_LEVELS)[number];

/** Plain-language maturity guidance ("Suitable for all ages", "Recommended for ages 16+"). */
export function maturityGuidance(rating: Maturity): string {
  if (rating === "ALL") return "Suitable for all ages";
  return `Recommended for ages ${rating.replace("+", "")} and up`;
}

/**
 * Quality badge ("HD", "Full HD", "4K"): the lower of the best quality the title is packaged in
 * and the plan's cap, so nothing is promised that this member cannot get. Null when the title's
 * quality is unknown (external fallback media): no badge then.
 */
export function qualityLabel(
  title: Pick<TitleCard, "bestVideoQuality">,
  plan: Pick<Plan, "maxVideoHeight">,
): string | null {
  const tier = effectiveVideoQuality(title.bestVideoQuality, plan.maxVideoHeight);
  return tier ? videoQualityLabel(tier) : null;
}

const LANGUAGE_NAMES: Record<string, string> = {};

/** "en" → "English" (Intl where available, the tag itself otherwise). */
export function languageName(tag: string): string {
  const cached = LANGUAGE_NAMES[tag];
  if (cached) return cached;
  let name = tag;
  try {
    name = new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    // Unknown or malformed tag: show it as is.
  }
  LANGUAGE_NAMES[tag] = name;
  return name;
}

/** Compact relative time for notifications: "Just now", "5m", "3h", "Yesterday", "4d", "12 Nov". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Up to `max` genre names joined for a metadata line. */
export function genreLine(card: Pick<TitleCard, "genres">, max = 3): string[] {
  return card.genres.slice(0, max).map((genre) => genre.name);
}

/**
 * "#2 in Series Today" from a ranked row's title ("Top 10 Series Today", "Top 10 on Webflix
 * Today"). Falls back to "#2 in <row title>" for titles that do not follow that pattern.
 */
export function rankLabel(rank: number, rowTitle: string): string {
  const rest = rowTitle.replace(/^Top 10\s+/i, "");
  if (rest === rowTitle) return `#${rank} in ${rowTitle}`;
  return /^(on|in)\s/i.test(rest) ? `#${rank} ${rest}` : `#${rank} in ${rest}`;
}

/**
 * "#3 on Webflix Today", "#2 in Series Today": a card's `top10Rank` in the words of the Top 10
 * row it refers to, the one of the browse view it is shown in (by its type on New & Popular; the
 * overall list outside browse views, `view` null). Null when the title is not ranked.
 */
export function top10RankLabel(
  card: Pick<TitleCard, "top10Rank" | "type">,
  view: BrowseView | null,
): string | null {
  if (card.top10Rank === undefined) return null;
  const type =
    view === "new-popular"
      ? card.type
      : view === "series"
        ? "series"
        : view === "movies"
          ? "movie"
          : null;
  const list =
    type === "series"
      ? "in Series Today"
      : type === "movie"
        ? "in Movies Today"
        : "on Webflix Today";
  return `#${card.top10Rank} ${list}`;
}
