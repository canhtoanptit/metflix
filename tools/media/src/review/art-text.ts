/**
 * Text-free key art (part of `check-art`). The billboard and the detail hero lay the title's
 * logo over the backdrop, and cards and posters set it over the same frames, so a real film's
 * key and poster frames (and any pinned still frames) must be clear of the film's burned-in
 * text and its on-screen story text, by the footage margin (`frameShowsText`). Episode stills
 * cut from real films are chosen among text-free candidates only (`stillCandidateTimes`).
 *
 * Photo and procedural art carries no text by construction: photos were reviewed for signs,
 * marks and plates when they were pinned, and the billboard and logo review sheets show every
 * backdrop under its logo, so anything else is caught by eye there.
 */
import { frameShowsText, type OpenFilm } from "@webflix/catalog";
import type { TitleSeed, VideoAssetSeed } from "@webflix/contracts";

interface FrameDirection {
  key?: number;
  poster?: number;
  stills?: number[];
  asset?: string;
}

export interface FrameCheck {
  /** Frames checked (key, poster and pinned stills of every real-film title). */
  checked: number;
  problems: string[];
}

export function checkArtFrames(
  titles: readonly TitleSeed[],
  videoAssets: readonly VideoAssetSeed[],
  films: readonly OpenFilm[],
): FrameCheck {
  const sourceOf = new Map(videoAssets.map((asset) => [asset.id, asset.source]));
  const filmOfAsset = (assetId: string | undefined) => {
    const source = assetId ? sourceOf.get(assetId) : undefined;
    return source?.kind === "download"
      ? films.find((film) => film.source.url === source.url)
      : undefined;
  };
  const report: FrameCheck = { checked: 0, problems: [] };
  for (const title of titles) {
    const frames = (title.art as { frames?: FrameDirection } | undefined)?.frames;
    if (!frames) continue;
    const film = filmOfAsset(
      frames.asset ??
        (title.type === "movie" ? title.videoAssetId : title.seasons[0]?.episodes[0]?.videoAssetId),
    );
    if (!film) {
      report.problems.push(`${title.id}: art frames, but no open film to cut them from`);
      continue;
    }
    const named: [string, number | undefined][] = [
      ["key", frames.key],
      ["poster", frames.poster],
      ...(frames.stills ?? []).map((at, i): [string, number] => [`still ${i + 1}`, at]),
    ];
    for (const [name, at] of named) {
      if (at === undefined) continue;
      report.checked += 1;
      if (frameShowsText(film, at))
        report.problems.push(
          `${title.id}: ${name} frame at ${at} s of ${film.name} is within the text margin of burned-in or on-screen text`,
        );
    }
  }
  return report;
}
