/**
 * Turns the catalog seed into packaging jobs: which assets are played (full ladder) and which
 * only preview, what window of the source each profile packages, and the Skip Intro / Skip
 * Recap / credits markers in each packaged asset's own timeline. Markers only ever describe
 * what is on screen: a film's real opening titles and end credits when the window holds them,
 * and a recap where a chapter really opens with the end of the one before.
 */
import type { CatalogSeed, VideoAssetSeed } from "@webflix/contracts";
import type { ProfileConfig } from "../profiles.ts";
import type { Markers, TimeWindow } from "./package.ts";

/** What the pipeline knows about a source film beyond the seed (see `OpenFilm`). */
export interface FilmFacts {
  durationSec: number;
  intro: readonly [number, number] | null;
  creditsStartSec: number;
  chapters: readonly (readonly [number, number])[];
  subtitles: readonly (readonly [string, string])[];
}

export type AssetRole = "film" | "episode" | "preview";

export interface PlannedAsset {
  seed: VideoAssetSeed;
  /** How the catalog uses it: a movie, an episode, or only a preview clip. */
  role: AssetRole;
  previewed: boolean;
  /** Source window before profile clipping (null duration = to the end of the source). */
  window: { startSec: number; durationSec: number | null };
  /** Motion-art previews: the title whose key art the clip is rendered from. */
  artTitleId: string | null;
  /** A feature cut: a movie window cut from a longer source (not the complete film). */
  feature: boolean;
}

/** Classify every seed asset by how titles use it. */
export function planAssets(catalog: CatalogSeed): PlannedAsset[] {
  const roles = new Map<string, AssetRole>();
  const previewed = new Set<string>();
  const previewOf = new Map<string, string>();
  for (const title of catalog.titles) {
    if (title.previewAssetId) previewOf.set(title.previewAssetId, title.id);
  }
  for (const title of catalog.titles) {
    if (title.type === "movie") {
      roles.set(title.videoAssetId, "film");
      previewed.add(title.previewAssetId ?? title.videoAssetId);
      continue;
    }
    for (const season of title.seasons) {
      for (const episode of season.episodes) {
        if (roles.get(episode.videoAssetId) !== "film") roles.set(episode.videoAssetId, "episode");
      }
    }
    const firstEpisode = title.seasons[0]?.episodes[0];
    const fallback = firstEpisode?.videoAssetId;
    const preview = title.previewAssetId ?? fallback;
    if (preview) previewed.add(preview);
  }
  return catalog.videoAssets.map((seed) => {
    const source = seed.source;
    const window =
      source.kind === "download"
        ? { startSec: source.startSec ?? 0, durationSec: source.durationSec ?? null }
        : { startSec: 0, durationSec: source.durationSec };
    const role = roles.get(seed.id) ?? "preview";
    return {
      seed,
      role,
      previewed: previewed.has(seed.id),
      window,
      artTitleId:
        source.kind === "synthetic" && role === "preview" ? (previewOf.get(seed.id) ?? null) : null,
      feature: role === "film" && source.kind === "download" && source.durationSec !== undefined,
    };
  });
}

/** The window a profile packages: the seed window, cut to the profile's maximum for the role. */
export function profileWindow(
  planned: PlannedAsset,
  sourceDurationSec: number,
  config: ProfileConfig,
): TimeWindow {
  const start = Math.min(planned.window.startSec, Math.max(0, sourceDurationSec - 1));
  const available = sourceDurationSec - start;
  const declared = planned.window.durationSec ?? available;
  const max =
    planned.role === "film"
      ? planned.feature
        ? config.maxSec.feature
        : config.maxSec.film
      : planned.role === "episode"
        ? config.maxSec.episode
        : config.maxSec.preview;
  const duration = Math.min(declared, available, max ?? Number.POSITIVE_INFINITY);
  return { startSec: start, durationSec: Math.max(1, Math.floor(duration * 1000) / 1000) };
}

/**
 * The preview excerpt inside a packaged window. Preview-only assets preview their whole
 * window; played assets preview a stretch a quarter of the way in (past cold opens and
 * opening titles).
 */
export function previewWindow(
  planned: PlannedAsset,
  window: TimeWindow,
  config: ProfileConfig,
): TimeWindow | null {
  if (!planned.previewed) return null;
  const length = Math.min(config.maxSec.preview, window.durationSec);
  if (planned.role === "preview") return { startSec: window.startSec, durationSec: length };
  const offset = Math.min(window.durationSec * 0.25, window.durationSec - length);
  return { startSec: window.startSec + Math.max(0, offset), durationSec: length };
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Markers in the packaged asset's timeline, honest to what is on screen: a film's own opening
 * titles and end credits when the window contains them, and a recap only where an episode
 * chapter really opens by replaying the end of the chapter before. Everything else is null
 * (text-free cuts have no title sequence and no credit roll to skip).
 */
export function markersFor(
  planned: PlannedAsset,
  window: TimeWindow,
  film: FilmFacts | null,
): Markers {
  const none: Markers = { intro: null, recap: null, creditsStartSec: null };
  if (planned.role === "preview" || !film) return none;
  const duration = window.durationSec;
  const end = window.startSec + duration;
  const toLocal = (sec: number) => round(sec - window.startSec);
  const inside = (sec: number) => sec > window.startSec && sec < end;

  const intro =
    film.intro && film.intro[0] >= window.startSec && inside(film.intro[1])
      ? { startSec: Math.max(0, toLocal(film.intro[0])), endSec: toLocal(film.intro[1]) }
      : null;
  const creditsStartSec = inside(film.creditsStartSec) ? toLocal(film.creditsStartSec) : null;

  let recap: Markers["recap"] = null;
  if (planned.role === "episode") {
    const index = film.chapters.findIndex(([start]) => Math.abs(start - window.startSec) < 0.5);
    const previous = index > 0 ? film.chapters[index - 1] : undefined;
    if (previous && previous[1] > window.startSec) {
      recap = { startSec: 0, endSec: round(Math.min(previous[1], end) - window.startSec) };
    }
  }
  return { intro, recap, creditsStartSec };
}
