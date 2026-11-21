/**
 * `webflix-media upload`: push a profile's tree (`public/…`, `vod/…`) and its manifest to a
 * blob store through the `BlobStore` port. Idempotent and concurrent: objects whose stored
 * SHA-256 (custom metadata) and size match the local file are skipped, so a second run only
 * lists and compares. `--prune` deletes stored objects under `public/` and `vod/` that the
 * profile no longer has.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { MediaProfile } from "@webflix/contracts";
import { type BlobStore, contentTypeForKey } from "@webflix/core";
import { manifestPath, mediaCacheDir, workDir } from "../paths.ts";
import { listFiles, readJson, writeJson } from "../util/fs.ts";
import { sha256, sha256File } from "../util/hash.ts";
import { formatBytes, formatDuration, log } from "../util/log.ts";
import { mapPool } from "../util/pool.ts";

/** Where the API's seed loader finds the manifest in any store. */
export const MANIFEST_KEYS = {
  current: "manifests/media.json",
  forProfile: (profile: MediaProfile) => `manifests/media-${profile}.json`,
} as const;

export function cacheControlForKey(key: string): string {
  if (key.startsWith("public/")) return "public, max-age=31536000, immutable";
  if (key.endsWith(".m3u8")) return "private, max-age=300";
  if (key.startsWith("vod/")) return "private, max-age=31536000, immutable";
  return "no-cache";
}

interface HashIndex {
  [path: string]: { size: number; mtimeMs: number; sha256: string };
}

export interface UploadOptions {
  concurrency?: number;
  prune?: boolean;
}

export interface UploadReport {
  uploaded: number;
  skipped: number;
  deleted: number;
  bytes: number;
}

async function listStore(store: BlobStore, prefix: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const page = await store.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const item of page.items) sizes.set(item.key, item.size);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return sizes;
}

export interface UploadTree {
  profile: MediaProfile;
  /** Directory laid out by blob key (`public/…`, `vod/…`). */
  root: string;
  manifestFile: string;
  /** Where hash and upload records are kept between runs. */
  stateDir: string;
  /** Distinguishes upload records per destination store. */
  targetId: string;
}

/**
 * Upload a key-laid-out tree. What was uploaded to which target is remembered locally, so a
 * re-run skips an object when the store still lists it at the same size, without a HEAD
 * request per object (thousands of segments on S3/R2); anything unknown is checked by HEAD
 * against the SHA-256 stored in its custom metadata.
 */
export async function uploadTree(
  tree: UploadTree,
  store: BlobStore,
  options: UploadOptions = {},
): Promise<UploadReport> {
  const started = Date.now();
  const { root, manifestFile, profile } = tree;
  try {
    await stat(manifestFile);
  } catch {
    throw new Error(
      `No manifest for ${profile}: run \`webflix-media build --profile ${profile}\` first`,
    );
  }
  const files = (await listFiles(root)).filter(
    (path) => path.startsWith("public/") || path.startsWith("vod/"),
  );

  // Hash only files that changed since the last run.
  const indexPath = join(tree.stateDir, "upload-hashes.json");
  const previous = (await readJson<HashIndex>(indexPath)) ?? {};
  const index: HashIndex = {};
  await mapPool(files, 32, async (path) => {
    const info = await stat(join(root, path));
    const known = previous[path];
    index[path] =
      known && known.size === info.size && known.mtimeMs === info.mtimeMs
        ? known
        : { size: info.size, mtimeMs: info.mtimeMs, sha256: await sha256File(join(root, path)) };
  });
  await writeJson(indexPath, index);

  const recordPath = join(tree.stateDir, `uploaded-${sha256(tree.targetId).slice(0, 12)}.json`);
  const uploaded = (await readJson<Record<string, string>>(recordPath)) ?? {};
  const stored = new Map([
    ...(await listStore(store, "public/")),
    ...(await listStore(store, "vod/")),
  ]);
  const report: UploadReport = { uploaded: 0, skipped: 0, deleted: 0, bytes: 0 };

  const put = async (key: string, path: string, sha: string, size: number) => {
    await store.put(
      key,
      { stream: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, size },
      {
        contentType: contentTypeForKey(key),
        cacheControl: cacheControlForKey(key),
        customMetadata: { sha256: sha },
      },
    );
    uploaded[key] = sha;
    report.uploaded += 1;
    report.bytes += size;
  };

  try {
    await mapPool(files, options.concurrency ?? 16, async (key) => {
      const entry = index[key];
      if (!entry) return;
      if (stored.get(key) === entry.size) {
        if (uploaded[key] === entry.sha256) {
          report.skipped += 1;
          return;
        }
        const head = await store.head(key);
        if (head?.customMetadata.sha256 === entry.sha256) {
          uploaded[key] = entry.sha256;
          report.skipped += 1;
          return;
        }
      }
      await put(key, join(root, key), entry.sha256, entry.size);
    });
  } finally {
    await writeJson(recordPath, uploaded);
  }

  if (options.prune) {
    const local = new Set(files);
    const stale = [...stored.keys()].filter((key) => !local.has(key));
    for (let offset = 0; offset < stale.length; offset += 1000) {
      await store.delete(stale.slice(offset, offset + 1000));
    }
    for (const key of stale) delete uploaded[key];
    await writeJson(recordPath, uploaded);
    report.deleted = stale.length;
  }

  // The manifest goes last: a reader never sees a manifest that points at missing blobs.
  const manifestSha = await sha256File(manifestFile);
  const manifestSize = (await stat(manifestFile)).size;
  for (const key of [MANIFEST_KEYS.forProfile(profile), MANIFEST_KEYS.current]) {
    const head = await store.head(key);
    if (head?.customMetadata.sha256 === manifestSha) {
      report.skipped += 1;
      continue;
    }
    await put(key, manifestFile, manifestSha, manifestSize);
  }
  await writeJson(recordPath, uploaded);

  log.info(
    `upload ${profile}: ${report.uploaded} uploaded (${formatBytes(report.bytes)}), ${report.skipped} unchanged, ${report.deleted} deleted in ${formatDuration(Date.now() - started)}`,
  );
  return report;
}

export function uploadProfile(
  profile: MediaProfile,
  store: BlobStore,
  targetId: string,
  options: UploadOptions = {},
): Promise<UploadReport> {
  return uploadTree(
    {
      profile,
      root: mediaCacheDir(profile),
      manifestFile: manifestPath(profile),
      stateDir: workDir(profile),
      targetId,
    },
    store,
    options,
  );
}
