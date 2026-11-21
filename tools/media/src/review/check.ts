/**
 * `webflix-media check-art`: perceptual-hash checks over the rendered artwork, so no two titles
 * share a backdrop or poster and no two episodes of a series share a still.
 *
 * Each image gets a 64-bit difference hash (dHash: a 9×8 greyscale thumbnail, one bit per
 * horizontal gradient) plus a colour signature; two images are duplicates when both are close
 * (Hamming distance ≤ `MAX_DISTANCE` and similar mean colour). Different crops, framings or
 * scenes of the same photo land far apart; re-encodes and tiny shifts of one image do not.
 */
import { join } from "node:path";
import { catalog } from "@webflix/catalog";
import { fillImageTemplate, type MediaManifest, type MediaProfile } from "@webflix/contracts";
import sharp from "sharp";
import { resolveDirection } from "../art/direction.ts";
import { cachedPhoto, readPhotoLibrary } from "../art/photos.ts";
import { manifestPath, mediaCacheDir } from "../paths.ts";
import { readJson } from "../util/fs.ts";
import { log } from "../util/log.ts";

/** At most this many of 64 hash bits may differ for two images to count as the same. */
export const MAX_DISTANCE = 10;
/** …and their mean colours must be this close (0–255 per channel, Euclidean). */
const MAX_COLOUR_DISTANCE = 28;

export interface ImageHash {
  hash: bigint;
  colour: readonly [number, number, number];
}

export async function hashImage(path: string | Buffer): Promise<ImageHash> {
  const grey = await sharp(path).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = grey[y * 9 + x] ?? 0;
      const right = grey[y * 9 + x + 1] ?? 0;
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  const { channels } = await sharp(path).removeAlpha().stats();
  const colour = [channels[0]?.mean ?? 0, channels[1]?.mean ?? 0, channels[2]?.mean ?? 0] as const;
  return { hash, colour };
}

export function hamming(a: bigint, b: bigint): number {
  let value = a ^ b;
  let count = 0;
  while (value) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

/** `slack` widens both thresholds, for callers that want a safety margin (still rendering). */
export function sameImage(a: ImageHash, b: ImageHash, slack = 0): boolean {
  const colour = Math.hypot(
    a.colour[0] - b.colour[0],
    a.colour[1] - b.colour[1],
    a.colour[2] - b.colour[2],
  );
  return (
    hamming(a.hash, b.hash) <= MAX_DISTANCE + slack && colour <= MAX_COLOUR_DISTANCE + slack * 3
  );
}

/** Every pair of `items` whose images are the same. */
export function duplicatePairs<T>(items: readonly { id: T; image: ImageHash }[]): [T, T][] {
  const pairs: [T, T][] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (a && b && sameImage(a.image, b.image)) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}

/**
 * What each title's key art is made from: its own film's frames, a photo, or (when the photo
 * is not cached) a procedural genre scene. Two titles on the same photo or the same procedural
 * scene and palette read as one title twice even when their crops differ, so sources are
 * compared directly, not only through image hashes.
 */
export async function artSources(): Promise<Map<string, string>> {
  const photos = new Map((await readPhotoLibrary()).map((photo) => [photo.id, photo]));
  const genres = new Map(catalog.genres.map((genre) => [genre.id, genre.slug]));
  const sources = new Map<string, string>();
  for (const title of catalog.titles) {
    const direction = resolveDirection(
      title,
      title.genreIds.map((id) => genres.get(id) ?? "drama"),
      photos,
      () => "film",
    );
    const source = direction.source;
    if (source.kind === "frames") sources.set(title.id, `frames:${title.id}`);
    else if (source.kind === "photo" && (await cachedPhoto(source.photo)))
      sources.set(title.id, `photo:${source.photo.id}`);
    else {
      const scene = source.kind === "procedural" ? source : direction.fallback;
      sources.set(title.id, `procedural:${scene.scene}:${scene.palette.join("")}`);
    }
  }
  return sources;
}

export interface ArtCheckReport {
  /** Titles whose key art comes from the same photo or the same procedural scene. */
  sharedSources: { source: string; titles: string[] }[];
  /** Titles on procedural fallback art (their photo is not cached). */
  procedural: string[];
  backdrops: [string, string][];
  posters: [string, string][];
  /** Per series: pairs of episode ids with the same still. */
  stills: { titleId: string; pairs: [string, string][] }[];
  stillCount: number;
}

export async function checkArt(profile: MediaProfile): Promise<ArtCheckReport> {
  const manifest = await readJson<MediaManifest>(manifestPath(profile));
  if (!manifest) throw new Error(`No manifest for ${profile}; run build first`);
  const root = mediaCacheDir(profile);
  const file = (template: string, width: number) =>
    join(root, fillImageTemplate(template, width, "webp"));

  const backdrops: { id: string; image: ImageHash }[] = [];
  const posters: { id: string; image: ImageHash }[] = [];
  for (const art of manifest.titleArtwork) {
    backdrops.push({
      id: art.titleId,
      image: await hashImage(file(art.backdrop.keyTemplate, 640)),
    });
    posters.push({ id: art.titleId, image: await hashImage(file(art.poster.keyTemplate, 400)) });
  }
  const stillByEpisode = new Map(manifest.episodeStills.map((entry) => [entry.episodeId, entry]));
  const stills: ArtCheckReport["stills"] = [];
  let stillCount = 0;
  for (const title of catalog.titles) {
    if (title.type !== "series") continue;
    const hashed: { id: string; image: ImageHash }[] = [];
    for (const episode of title.seasons.flatMap((season) => season.episodes)) {
      const still = stillByEpisode.get(episode.id)?.still;
      if (!still) continue;
      stillCount += 1;
      hashed.push({ id: episode.id, image: await hashImage(file(still.keyTemplate, 320)) });
    }
    const pairs = duplicatePairs(hashed);
    if (pairs.length > 0) stills.push({ titleId: title.id, pairs });
  }
  const sources = await artSources();
  const byTitles = new Map<string, string[]>();
  for (const [titleId, source] of sources)
    byTitles.set(source, [...(byTitles.get(source) ?? []), titleId]);
  return {
    sharedSources: [...byTitles]
      .filter(([, titles]) => titles.length > 1)
      .map(([source, titles]) => ({ source, titles })),
    procedural: [...sources]
      .filter(([, source]) => source.startsWith("procedural:"))
      .map(([id]) => id),
    backdrops: duplicatePairs(backdrops),
    posters: duplicatePairs(posters),
    stills,
    stillCount,
  };
}

/** CLI: print the report; non-zero exit when anything is shared. */
export async function runArtCheck(profile: MediaProfile): Promise<number> {
  const report = await checkArt(profile);
  const stillPairs = report.stills.reduce((total, entry) => total + entry.pairs.length, 0);
  for (const entry of report.sharedSources)
    log.warn(`same key-art source ${entry.source}: ${entry.titles.join(", ")}`);
  if (report.procedural.length > 0)
    log.warn(`procedural fallback art (photo not cached): ${report.procedural.join(", ")}`);
  for (const [a, b] of report.backdrops) log.warn(`same backdrop: ${a} ~ ${b}`);
  for (const [a, b] of report.posters) log.warn(`same poster: ${a} ~ ${b}`);
  for (const entry of report.stills)
    for (const [a, b] of entry.pairs) log.warn(`same still in ${entry.titleId}: ${a} ~ ${b}`);
  log.info(
    `check-art ${profile}: ${report.sharedSources.length} shared key-art sources, ${report.procedural.length} procedural fallbacks, ${report.backdrops.length} shared backdrops, ${report.posters.length} shared posters, ${stillPairs} duplicate still pairs across ${report.stills.length} series (${report.stillCount} stills)`,
  );
  const problems =
    report.sharedSources.length + report.backdrops.length + report.posters.length + stillPairs;
  return problems > 0 ? 1 : 0;
}
