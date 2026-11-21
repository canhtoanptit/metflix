/**
 * Assembles `.cache/media/<profile>/manifest.json` from the art and video stages, links the
 * profile-independent artwork into the profile's publishable tree, and validates the result
 * against the `MediaManifest` contract before writing it.
 */
import { rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { MediaManifest, type MediaProfile, type PackagedVideoAsset } from "@webflix/contracts";
import type { ArtResult } from "./art/run.ts";
import { ART_DIR, manifestPath, mediaCacheDir } from "./paths.ts";
import { linkFile, listFiles, readJson, writeJson } from "./util/fs.ts";
import { stableStringify } from "./util/hash.ts";
import { log } from "./util/log.ts";
import { mapPool } from "./util/pool.ts";

/** Hard-link rendered artwork into the profile tree and drop artwork that no longer exists. */
export async function linkArtwork(profile: MediaProfile, art: ArtResult): Promise<void> {
  const out = mediaCacheDir(profile);
  const wanted = new Set(art.files.map((file) => relative(ART_DIR, file)));
  await mapPool([...wanted], 16, async (path) => {
    const source = join(ART_DIR, path);
    const target = join(out, path);
    try {
      const [a, b] = await Promise.all([stat(source), stat(target)]);
      if (a.ino === b.ino) return;
    } catch {
      // Missing target: link it.
    }
    await linkFile(source, target);
  });
  let pruned = 0;
  for (const path of await listFiles(join(out, "public", "img"))) {
    const relativePath = `public/img/${path}`;
    if (!wanted.has(relativePath)) {
      await rm(join(out, relativePath), { force: true });
      pruned += 1;
    }
  }
  if (pruned > 0) log.info(`pruned ${pruned} stale artwork files from ${profile}`);
}

/** Remove packaged assets that are no longer in the catalog. */
export async function pruneVideo(
  profile: MediaProfile,
  assets: readonly PackagedVideoAsset[],
): Promise<void> {
  const out = mediaCacheDir(profile);
  const keep = new Set(assets.map((asset) => asset.assetId));
  const { readdir } = await import("node:fs/promises");
  for (const dir of ["vod", join("public", "previews")]) {
    let entries: string[] = [];
    try {
      entries = await readdir(join(out, dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!keep.has(entry)) await rm(join(out, dir, entry), { recursive: true, force: true });
    }
  }
}

export async function writeManifest(
  profile: MediaProfile,
  videoAssets: readonly PackagedVideoAsset[],
  art: ArtResult,
): Promise<MediaManifest> {
  const path = manifestPath(profile);
  const body = {
    version: 1 as const,
    profile,
    videoAssets: [...videoAssets].sort((a, b) => a.assetId.localeCompare(b.assetId)),
    titleArtwork: [...art.titleArtwork].sort((a, b) => a.titleId.localeCompare(b.titleId)),
    episodeStills: [...art.episodeStills].sort((a, b) => a.episodeId.localeCompare(b.episodeId)),
    avatars: [...art.avatars].sort((a, b) => a.avatarId.localeCompare(b.avatarId)),
  };
  // Keep `generatedAt` when nothing else changed, so an unchanged rebuild rewrites nothing.
  const previous = await readJson<MediaManifest>(path);
  const unchanged =
    previous !== null &&
    stableStringify({ ...previous, generatedAt: undefined }) ===
      stableStringify({ ...body, generatedAt: undefined });
  const manifest = MediaManifest.parse({
    ...body,
    generatedAt: unchanged && previous ? previous.generatedAt : new Date().toISOString(),
  });
  if (!unchanged) await writeJson(path, manifest);
  return manifest;
}
