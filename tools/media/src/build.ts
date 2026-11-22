/**
 * `webflix-media build`: art stage, video stage, then the manifest. Each stage is incremental,
 * so a second run with unchanged inputs only re-checks stamps (seconds).
 */
import { catalog, openFilms } from "@webflix/catalog";
import type { MediaProfile, PackagedVideoAsset } from "@webflix/contracts";
import { runArtStage } from "./art/run.ts";
import { linkArtwork, pruneVideo, writeManifest } from "./manifest.ts";
import { manifestPath } from "./paths.ts";
import { checkPublished, publishedBefore } from "./published.ts";
import { readJson } from "./util/fs.ts";
import { formatBytes, formatDuration, log, timed } from "./util/log.ts";
import type { FilmFacts } from "./video/plan.ts";
import { resolveFilm, runVideoStage } from "./video/run.ts";

export interface BuildOptions {
  only?: readonly string[] | undefined;
  skipVideo?: boolean;
  skipArt?: boolean;
}

export function filmFacts(): Map<string, FilmFacts & { key: string }> {
  return new Map(
    openFilms.map((film) => [
      film.source.url,
      {
        key: film.key,
        durationSec: film.durationSec,
        intro: film.intro,
        creditsStartSec: film.creditsStartSec,
        chapters: film.chapters,
        subtitles: film.subtitles,
      },
    ]),
  );
}

export async function build(profile: MediaProfile, options: BuildOptions = {}): Promise<number> {
  const started = Date.now();
  const films = filmFacts();
  const shaByUrl = new Map(openFilms.map((film) => [film.source.url, film.source.sha256]));

  const art = options.skipArt
    ? null
    : await timed("art", () =>
        runArtStage(
          catalog,
          async (url) => {
            const film = await resolveFilm(url, shaByUrl.get(url) ?? null);
            return film && { ...film, durationSec: film.probe.durationSec };
          },
          {
            only: options.only,
          },
        ),
      );

  let video: PackagedVideoAsset[] | null = null;
  if (!options.skipVideo) {
    // Immutable public keys (preview clips) must never change bytes: snapshot what this
    // profile has published before, package, then compare (src/published.ts).
    const before = await publishedBefore(profile);
    video = await timed(`video (${profile})`, () =>
      runVideoStage(catalog, films, profile, { only: options.only }),
    );
    await checkPublished(
      profile,
      before,
      video.flatMap((asset) => (asset.preview ? [asset.preview.key] : [])),
    );
  }

  if (options.only) {
    log.info("--only: rendered a subset; the manifest was left untouched");
    return 0;
  }
  const previous = await readJson<{ videoAssets: PackagedVideoAsset[] }>(manifestPath(profile));
  const videoAssets = video ?? previous?.videoAssets ?? [];
  if (!art) {
    log.warn("--skip-art: the manifest needs artwork; run without --skip-art to write it");
    return 0;
  }
  await linkArtwork(profile, art);
  if (video) await pruneVideo(profile, video);
  const manifest = await writeManifest(profile, videoAssets, art);
  const bytes = manifest.videoAssets.reduce((total, asset) => total + asset.bytes, 0);
  const synthetic = manifest.videoAssets.filter((asset) => asset.synthetic).length;
  log.info(
    `manifest ${manifestPath(profile)}: ${manifest.videoAssets.length} video assets (${formatBytes(bytes)}${synthetic ? `, ${synthetic} synthetic` : ""}), ${manifest.titleArtwork.length} titles, ${manifest.episodeStills.length} stills, ${manifest.avatars.length} avatars`,
  );
  log.info(`build ${profile} finished in ${formatDuration(Date.now() - started)}`);
  return 0;
}
