/** `webflix-media status`: what the cache holds, per area and profile. */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_PROFILES, type MediaManifest } from "@webflix/contracts";
import { dockerAvailable, imageTag } from "./docker.ts";
import { ART_DIR, DOWNLOADS_DIR, manifestPath, mediaCacheDir } from "./paths.ts";
import { listFiles, readJson } from "./util/fs.ts";
import { formatBytes } from "./util/log.ts";

async function treeSize(dir: string): Promise<{ files: number; bytes: number }> {
  let bytes = 0;
  const files = await listFiles(dir);
  for (const file of files) bytes += (await stat(join(dir, file))).size;
  return { files: files.length, bytes };
}

export async function status(): Promise<number> {
  const docker = await dockerAvailable();
  console.log(`docker: ${docker ? "available" : "NOT available"}; image ${await imageTag()}`);
  for (const [label, dir] of [
    ["downloads", DOWNLOADS_DIR],
    ["art", ART_DIR],
  ] as const) {
    const size = await treeSize(dir);
    console.log(
      `${label.padEnd(10)} ${String(size.files).padStart(6)} files ${formatBytes(size.bytes).padStart(10)}  ${dir}`,
    );
  }
  for (const profile of MEDIA_PROFILES) {
    const size = await treeSize(mediaCacheDir(profile));
    const manifest = await readJson<MediaManifest>(manifestPath(profile));
    const summary = manifest
      ? `${manifest.videoAssets.length} assets (${manifest.videoAssets.filter((a) => a.synthetic).length} synthetic), generated ${manifest.generatedAt}`
      : "no manifest";
    console.log(
      `${profile.padEnd(10)} ${String(size.files).padStart(6)} files ${formatBytes(size.bytes).padStart(10)}  ${summary}`,
    );
  }
  return 0;
}
