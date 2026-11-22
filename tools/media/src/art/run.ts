/**
 * Art stage: renders every title's backdrop, card, poster and logo, every episode still and
 * every avatar into `.cache/media/art` (blob layout, profile-independent). Each title is a
 * cached step keyed by its data, art direction, source image and the renderer's code, so
 * re-running with nothing changed renders nothing.
 */
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { frameShowsText, type OpenFilm, openFilms } from "@webflix/catalog";
import {
  type AvatarImage,
  blobKeys,
  type CatalogSeed,
  type EpisodeStill,
  type TitleArtwork,
  type TitleSeed,
} from "@webflix/contracts";
import sharp from "sharp";
import { containerPath, ffmpeg } from "../docker.ts";
import { ART_DIR, artMasterPath, FONTS_DIR, MEDIA_ROOT, TOOL_ROOT } from "../paths.ts";
import { hashImage, type ImageHash, sameImage } from "../review/check.ts";
import { ensureDir, exists, writeFileAtomic } from "../util/fs.ts";
import { fingerprintFiles, hashJson, sha256 } from "../util/hash.ts";
import { formatDuration, log } from "../util/log.ts";
import { mapPool } from "../util/pool.ts";
import { cachedStep, stampPath } from "../util/stamp.ts";
import { renderAvatar } from "./avatars.ts";
import {
  composeLogo,
  composeWithTitle,
  cropGrade,
  loadRaster,
  MASTER,
  type RasterImage,
  toPng,
} from "./compose.ts";
import { type ProceduralSource, type ResolvedDirection, resolveDirection } from "./direction.ts";
import { WIDTHS, writeAvatar, writeImageSet } from "./encode.ts";
import { cachedPhoto, fetchPhotos, type PhotoRecord, readPhotoLibrary } from "./photos.ts";
import { renderScene } from "./procedural.ts";

const ART_WORK = join(MEDIA_ROOT, "work", "art");

export interface ArtResult {
  titleArtwork: TitleArtwork[];
  episodeStills: EpisodeStill[];
  avatars: AvatarImage[];
  /** Every file written under ART_DIR (for linking into a profile tree). */
  files: string[];
}

/** A film file on disk, for titles whose art is cut from the film itself. */
export type FilmFileLookup = (
  url: string,
) => Promise<{ path: string; sha256: string; durationSec?: number } | null>;

async function frameAt(film: { path: string; sha256: string }, seconds: number): Promise<string> {
  const dir = await ensureDir(join(ART_WORK, "frames", film.sha256.slice(0, 16)));
  const target = join(dir, `${seconds.toFixed(2)}.png`);
  if (!(await exists(target))) {
    await ffmpeg([
      "-ss",
      seconds.toFixed(3),
      "-i",
      containerPath(film.path),
      "-frames:v",
      "1",
      "-update",
      "1",
      containerPath(target),
    ]);
  }
  return target;
}

/**
 * How good a frame is as a thumbnail: detail (entropy), contrast and colour, minus a penalty
 * for near-black or blown-out frames (fades, flashes, extreme close-ups of a dark surface).
 */
async function frameInterest(path: string): Promise<number> {
  const { channels, entropy } = await sharp(path).resize(192).removeAlpha().stats();
  const [r, g, b] = channels;
  if (!r || !g || !b) return 0;
  const luma = 0.2126 * r.mean + 0.7152 * g.mean + 0.0722 * b.mean;
  const contrast = (r.stdev + g.stdev + b.stdev) / 3;
  const colour = (Math.abs(r.mean - g.mean) + Math.abs(g.mean - b.mean)) / 2;
  const exposure = luma < 45 ? (45 - luma) / 15 : luma > 215 ? (luma - 215) / 15 : 0;
  return entropy + contrast / 24 + colour / 40 - exposure;
}

/**
 * Where an episode still may be taken from: a few points across the middle of the episode's
 * window, minus any that would show text (an open film's credits, cards or on-screen story
 * text, margin included; the logo and episode title are laid over stills).
 */
export function stillCandidateTimes(
  start: number,
  length: number,
  film: OpenFilm | undefined,
): number[] {
  const times = [0.2, 0.32, 0.44, 0.56, 0.68].map((at) => start + length * at);
  const clean = film ? times.filter((time) => !frameShowsText(film, time)) : times;
  if (clean.length === 0)
    throw new Error(`no text-free still candidate in ${film?.key} at ${start}`);
  return clean;
}

/** The most thumbnail-worthy of the candidate frames. */
async function bestFrame(
  film: { path: string; sha256: string },
  times: readonly number[],
): Promise<string> {
  let best: { path: string; score: number } | null = null;
  for (const time of times) {
    const path = await frameAt(film, time);
    const score = await frameInterest(path);
    if (!best || score > best.score) best = { path, score };
  }
  if (!best) throw new Error("no still candidates");
  return best.path;
}

async function proceduralRaster(
  source: ProceduralSource,
  focus: readonly [number, number],
): Promise<RasterImage> {
  const width = 2880;
  const height = 1620;
  return { data: renderScene(width, height, { ...source, focus }), width, height };
}

/**
 * Episode still framings. Episode i uses source i mod n (the series' still photos, then its key
 * image); each further use of the same source takes the next framing, so no two stills of a
 * series repeat a crop: wide, tight left, tight right (mirrored), high, low detail…
 */
const STILL_FRAMINGS: readonly { zoom: number; focus: readonly [number, number]; flip: boolean }[] =
  [
    { zoom: 1, focus: [0.5, 0.5], flip: false },
    { zoom: 1.6, focus: [0.22, 0.45], flip: false },
    { zoom: 1.6, focus: [0.78, 0.55], flip: true },
    { zoom: 1.3, focus: [0.5, 0.22], flip: true },
    { zoom: 2, focus: [0.36, 0.7], flip: false },
    { zoom: 1.45, focus: [0.68, 0.75], flip: true },
    { zoom: 2.2, focus: [0.58, 0.38], flip: false },
    { zoom: 1.2, focus: [0.28, 0.62], flip: true },
  ];

function stillFraming(use: number, source: RasterImage, seed: number) {
  const base = STILL_FRAMINGS[use % STILL_FRAMINGS.length] ?? {
    zoom: 1,
    focus: [0.5, 0.5],
    flip: false,
  };
  const lap = Math.floor(use / STILL_FRAMINGS.length);
  // Never crop narrower than ~640 px of source for a 960 px still (keeps stills sharp enough).
  const widest = Math.min(source.width, (source.height * 16) / 9);
  const h = Number.parseInt(sha256(`${seed}:${use}`).slice(0, 8), 16);
  return {
    zoom: Math.max(1, Math.min(base.zoom, widest / 640)),
    focus: base.focus,
    flip: lap % 2 === 1 ? !base.flip : base.flip,
    exposure: ((h % 13) - 6) / 60,
  };
}

async function renderTitle(
  title: TitleSeed,
  direction: ResolvedDirection,
  filmFile: { path: string; sha256: string } | null,
  episodeFrame: (videoAssetId: string) => Promise<string | null>,
): Promise<{
  value: { artwork: TitleArtwork; stills: EpisodeStill[] };
  outputs: string[];
  provisional: boolean;
}> {
  const files: string[] = [];
  let provisional = false;
  let source: RasterImage;
  let posterSource: RasterImage;
  let effective = direction;
  if (direction.source.kind === "frames" && filmFile) {
    source = await loadRaster(await frameAt(filmFile, direction.source.key));
    posterSource =
      direction.source.poster === direction.source.key
        ? source
        : await loadRaster(await frameAt(filmFile, direction.source.poster));
  } else if (direction.source.kind === "photo") {
    const path = await cachedPhoto(direction.source.photo);
    if (path) {
      source = await loadRaster(path);
    } else {
      provisional = true;
      source = await proceduralRaster(direction.fallback, direction.focus);
      effective = { ...direction, source: direction.fallback };
    }
    posterSource = source;
  } else {
    source = await proceduralRaster(
      direction.source.kind === "procedural" ? direction.source : direction.fallback,
      direction.focus,
    );
    posterSource = source;
  }

  const { seed, flip } = effective;
  // Procedural scenes are already stylised: keep the look's colour, but never darken them.
  const grade =
    effective.source.kind === "procedural"
      ? {
          ...effective.grade,
          exposure: Math.max(0, effective.grade.exposure),
          vignette: Math.min(0.35, effective.grade.vignette),
        }
      : effective.grade;
  const backdrop = await cropGrade(
    source,
    MASTER.backdrop,
    direction.focus,
    [0.62, 0.45],
    grade,
    seed,
    { flip },
  );
  const backdropPng = await toPng(backdrop);
  const backdropSet = await writeImageSet(
    backdropPng,
    blobKeys.titleImageTemplate(title.id, "backdrop"),
    WIDTHS.backdrop,
    ART_DIR,
  );
  files.push(...backdropSet.files);
  // The textless master the video stage animates into this title's motion-art preview.
  const master = artMasterPath(title.id);
  await ensureDir(dirname(master));
  await writeFileAtomic(master, backdropPng);
  files.push(master);

  const cardBackground = await cropGrade(
    source,
    MASTER.card,
    direction.focus,
    [0.6, 0.45],
    grade,
    seed,
    { flip },
  );
  const card = await composeWithTitle(cardBackground, title.name, direction.type, direction.card);
  const cardSet = await writeImageSet(
    card,
    blobKeys.titleImageTemplate(title.id, "card"),
    WIDTHS.card,
    ART_DIR,
  );
  files.push(...cardSet.files);

  const posterBackground = await cropGrade(
    posterSource,
    MASTER.poster,
    direction.posterFocus,
    [0.5, 0.42],
    grade,
    seed,
    { flip },
  );
  const poster = await composeWithTitle(
    posterBackground,
    title.name,
    direction.type,
    direction.poster,
  );
  const posterSet = await writeImageSet(
    poster,
    blobKeys.titleImageTemplate(title.id, "poster"),
    WIDTHS.poster,
    ART_DIR,
  );
  files.push(...posterSet.files);

  const logo = await composeLogo(title.name, direction.type);
  const logoSet = await writeImageSet(
    logo,
    blobKeys.titleImageTemplate(title.id, "logo"),
    WIDTHS.logo,
    ART_DIR,
    { alpha: true },
  );
  files.push(...logoSet.files);

  const stills: EpisodeStill[] = [];
  if (title.type === "series") {
    const episodes = title.seasons.flatMap((season) => season.episodes);
    const stillSources: RasterImage[] = [];
    const framesLook = direction.source.kind === "frames";
    if (!framesLook) {
      for (const photo of direction.stills) {
        const path = await cachedPhoto(photo, "still");
        if (path) stillSources.push(await loadRaster(path, 1920));
        else provisional = true;
      }
      stillSources.push(source);
    }
    // Each source's framings are used in turn; a framing that would look like a still this
    // series already has (perceptual hash) is skipped, so no two episodes share a still.
    const uses = stillSources.map(() => 0);
    const taken: ImageHash[] = [];
    for (const [index, episode] of episodes.entries()) {
      // Real series: each episode's still is a frame of that episode's own footage.
      const framePath = framesLook ? await episodeFrame(episode.videoAssetId) : null;
      let image: RasterImage | null = null;
      let png: Buffer | null = null;
      for (let attempt = 0; attempt < 2 * STILL_FRAMINGS.length && !png; attempt += 1) {
        const sourceIndex = (index + attempt) % Math.max(1, stillSources.length);
        const stillSource = framePath
          ? await loadRaster(framePath, 1920)
          : (stillSources[sourceIndex] ?? source);
        const use = uses[sourceIndex] ?? 0;
        uses[sourceIndex] = use + 1;
        const variant = stillFraming(use, stillSource, seed);
        const candidate = await cropGrade(
          stillSource,
          MASTER.still,
          framesLook ? [0.5, 0.5] : variant.focus,
          [0.5, 0.5],
          { ...grade, exposure: grade.exposure + variant.exposure },
          seed + index,
          { zoom: framesLook ? 1 : variant.zoom, flip: framesLook ? false : variant.flip },
        );
        const encoded = await toPng(candidate);
        // Hash exactly what check-art hashes: the 320 px WebP the image set publishes.
        const hash = await hashImage(
          await sharp(encoded)
            .resize({ width: 320, kernel: "lanczos3" })
            .webp({ quality: 80, alphaQuality: 90, effort: 4 })
            .toBuffer(),
        );
        // A margin over the check's threshold: the check hashes the small WebP, not this PNG.
        if (framesLook || !taken.some((other) => sameImage(other, hash, 4))) {
          taken.push(hash);
          image = candidate;
          png = encoded;
        }
      }
      if (!png || !image) {
        // Every framing collided (a tiny, uniform source): keep the last candidate anyway.
        const fallbackSource = stillSources[index % Math.max(1, stillSources.length)] ?? source;
        image = await cropGrade(
          fallbackSource,
          MASTER.still,
          [0.5, 0.5],
          [0.5, 0.5],
          grade,
          seed + index,
        );
        png = await toPng(image);
      }
      const set = await writeImageSet(
        png,
        blobKeys.episodeStillTemplate(episode.id),
        WIDTHS.still,
        ART_DIR,
      );
      files.push(...set.files);
      stills.push({ episodeId: episode.id, still: set.image });
    }
  }

  return {
    value: {
      artwork: {
        titleId: title.id,
        backdrop: backdropSet.image,
        card: cardSet.image,
        poster: posterSet.image,
        logo: logoSet.image,
      },
      stills,
    },
    outputs: files,
    provisional,
  };
}

export interface ArtStageOptions {
  only?: readonly string[];
  /** Parallel title renders (sharp is multi-threaded too). */
  jobs?: number;
}

export async function runArtStage(
  catalog: CatalogSeed,
  filmFile: FilmFileLookup,
  options: ArtStageOptions = {},
): Promise<ArtResult> {
  const started = Date.now();
  const artCode = await fingerprintFiles(
    (await readdir(join(TOOL_ROOT, "src", "art")))
      .filter(
        // Everything that shapes pixels (renderTitle lives here too); curation tools do not.
        (file) => file.endsWith(".ts") && !["curate.ts", "fonts-fetch.ts"].includes(file),
      )
      .map((file) => join(TOOL_ROOT, "src", "art", file))
      // The still de-duplication uses the review check's perceptual hash.
      .concat(join(TOOL_ROOT, "src", "review", "check.ts")),
  );
  const fonts = await fingerprintFiles(
    (await readdir(FONTS_DIR))
      .filter((file) => file.endsWith(".ttf"))
      .map((file) => join(FONTS_DIR, file)),
  );
  const photos = new Map<string, PhotoRecord>(
    (await readPhotoLibrary()).map((photo) => [photo.id, photo]),
  );
  const genres = new Map(catalog.genres.map((genre) => [genre.id, genre.slug]));
  const assets = new Map(catalog.videoAssets.map((asset) => [asset.id, asset]));
  const filmUrlFor = (title: TitleSeed, explicit?: string): string | null => {
    const assetId =
      explicit ??
      (title.type === "movie" ? title.videoAssetId : title.seasons[0]?.episodes[0]?.videoAssetId);
    const asset = assetId ? assets.get(assetId) : undefined;
    return asset?.source.kind === "download" ? asset.source.url : null;
  };

  const titles = catalog.titles.filter((title) => !options.only || options.only.includes(title.id));
  const directions = new Map(
    titles.map((title) => [
      title.id,
      resolveDirection(
        title,
        title.genreIds.map((id) => genres.get(id) ?? "drama"),
        photos,
        filmUrlFor,
      ),
    ]),
  );
  // Most visible first: key art of the most popular titles, then other key art, then stills.
  const byPopularity = [...titles].sort((a, b) => b.popularity - a.popularity);
  const keyPhotos = byPopularity.flatMap((title) => {
    const source = directions.get(title.id)?.source;
    return source?.kind === "photo" ? [{ record: source.photo, role: "key" as const }] : [];
  });
  const stillPhotos = byPopularity.flatMap((title) =>
    (directions.get(title.id)?.stills ?? []).map((record) => ({ record, role: "still" as const })),
  );
  const wanted = [...keyPhotos, ...stillPhotos];
  const budgetSec = Number(process.env.WEBFLIX_MEDIA_PHOTO_BUDGET_SEC ?? 600);
  const photoStatus = await fetchPhotos(wanted, budgetSec * 1000);
  if (photoStatus.pending.length > 0) {
    log.warn(
      `${photoStatus.pending.length} photos not fetched yet (Wikimedia throttles bulk downloads); those titles use procedural art until a later run fetches them`,
    );
  }
  let rendered = 0;
  const results = await mapPool(titles, options.jobs ?? 6, async (title) => {
    const direction = directions.get(title.id);
    if (!direction) throw new Error(`no art direction for ${title.id}`);
    const film =
      direction.source.kind === "frames" ? await filmFile(direction.source.filmUrl) : null;
    const episodeFrame = async (videoAssetId: string): Promise<string | null> => {
      const source = assets.get(videoAssetId)?.source;
      if (source?.kind !== "download") return null;
      const file = await filmFile(source.url);
      if (!file) return null;
      const start = source.startSec ?? 0;
      const length = source.durationSec ?? file.durationSec ?? 60;
      const open = openFilms.find((entry) => entry.source.url === source.url);
      return bestFrame(file, stillCandidateTimes(start, length, open));
    };
    const key = hashJson({
      title: {
        id: title.id,
        name: title.name,
        episodes:
          title.type === "series" ? title.seasons.flatMap((s) => s.episodes.map((e) => e.id)) : [],
      },
      direction,
      film: film?.sha256 ?? null,
      artCode,
      fonts,
    });
    const { value, cached } = await cachedStep(stampPath(ART_WORK, "titles", title.id), key, () =>
      renderTitle(title, direction, film, episodeFrame),
    );
    if (!cached) {
      rendered += 1;
      log.info(
        `art ${title.id} (${direction.typeName}, ${direction.gradeName}, ${direction.source.kind})`,
      );
    }
    return value;
  });

  const avatars: AvatarImage[] = [];
  const avatarFiles: string[] = [];
  for (const avatar of catalog.avatars) {
    const key = hashJson({ avatar, artCode });
    const { value } = await cachedStep(stampPath(ART_WORK, "avatars", avatar.id), key, async () => {
      const master = await renderAvatar(avatar);
      const written = await writeAvatar(master, blobKeys.avatar(avatar.id), ART_DIR);
      return {
        value: { avatarId: avatar.id, key: blobKeys.avatar(avatar.id), version: written.version },
        outputs: [written.file],
      };
    });
    avatars.push(value);
    avatarFiles.push(join(ART_DIR, value.key));
  }

  const files: string[] = [];
  for (const result of results) {
    const { artwork, stills } = result;
    for (const image of [
      artwork.backdrop,
      artwork.card,
      artwork.poster,
      artwork.logo,
      ...stills.map((s) => s.still),
    ]) {
      if (!image) continue;
      for (const width of image.widths) {
        for (const format of image.formats) {
          files.push(
            join(
              ART_DIR,
              image.keyTemplate.replace("{width}", String(width)).replace("{format}", format),
            ),
          );
        }
      }
    }
  }
  files.push(...avatarFiles);
  log.info(
    `art: ${results.length} titles (${rendered} rendered, ${results.length - rendered} cached), ${avatars.length} avatars in ${formatDuration(Date.now() - started)}`,
  );
  return {
    titleArtwork: results.map((result) => result.artwork),
    episodeStills: results.flatMap((result) => result.stills),
    avatars,
    files,
  };
}
