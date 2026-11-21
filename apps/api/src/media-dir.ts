import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  assertBlobKey,
  type BlobListPage,
  type BlobMetadata,
  type BlobObject,
  type BlobRange,
  type BlobStore,
  contentTypeForKey,
  resolveBlobRange,
} from "@webflix/core";

/**
 * Read-only `BlobStore` over a directory whose files are laid out by blob key
 * (`<root>/public/...`, `<root>/vod/...`), which is exactly what `tools/media` writes to
 * `.cache/media/<profile>/`. Dev mode layers it under the writable store so packaged media
 * plays without an upload step. Writes are refused: upload through a real store instead.
 */
export function createDirectoryBlobStore(root: string): BlobStore {
  const base = resolve(root);
  const pathOf = (key: string) => {
    assertBlobKey(key);
    const path = resolve(join(base, ...key.split("/")));
    // assertBlobKey already rejects traversal; this is defence in depth for the file system.
    if (!path.startsWith(base + sep))
      throw new RangeError(`Key escapes the media directory: ${key}`);
    return path;
  };
  const meta = async (key: string): Promise<BlobMetadata | null> => {
    try {
      const info = await stat(pathOf(key));
      if (!info.isFile()) return null;
      return {
        key,
        size: info.size,
        // Content changes rewrite the file (new mtime/size); good enough for a dev overlay.
        etag: `${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}`,
        contentType: contentTypeForKey(key),
        cacheControl: null,
        uploadedAt: Math.trunc(info.mtimeMs),
        customMetadata: {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const readOnly = async (): Promise<never> => {
    throw new Error("The media directory is read-only; upload through the configured blob store");
  };
  return {
    head: meta,
    async get(key, options: { range?: BlobRange } = {}): Promise<BlobObject | null> {
      const info = await meta(key);
      if (!info) return null;
      const range = options.range ? resolveBlobRange(options.range, info.size) : null;
      const stream = createReadStream(
        pathOf(key),
        range ? { start: range.offset, end: range.offset + range.length - 1 } : {},
      );
      return { ...info, range, body: Readable.toWeb(stream) as ReadableStream<Uint8Array> };
    },
    put: readOnly,
    delete: readOnly,
    async list(): Promise<BlobListPage> {
      return { items: [], cursor: null };
    },
  };
}

/** Reads try `primary` first, then `fallback`; writes and listings go to `primary` only. */
export function layerBlobStores(primary: BlobStore, fallback: BlobStore): BlobStore {
  return {
    head: async (key) => (await primary.head(key)) ?? fallback.head(key),
    get: async (key, options) => (await primary.get(key, options)) ?? fallback.get(key, options),
    put: (key, body, options) => primary.put(key, body, options),
    delete: (keys) => primary.delete(keys),
    list: (options) => primary.list(options),
  };
}
