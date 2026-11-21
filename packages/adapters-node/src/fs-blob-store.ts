import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertBlobKey,
  type BlobBody,
  type BlobListItem,
  type BlobListOptions,
  type BlobListPage,
  type BlobMetadata,
  type BlobObject,
  type BlobPutOptions,
  type BlobRange,
  type BlobStore,
  bytesToStream,
  type Clock,
  compareBlobKeys,
  contentTypeForKey,
  normalizeDeleteKeys,
  resolveBlobRange,
  resolveListLimit,
  systemClock,
} from "@webflix/core";

/**
 * On-disk names: every byte outside `[a-z0-9._-]` is percent-encoded with lowercase hex.
 * Case-insensitive (macOS) and normalising filesystems therefore cannot merge keys that the
 * object stores keep apart ("a/Z" vs "a/z", NFC vs NFD), and keys built from our blob layout
 * stay human-readable on disk.
 *
 * Object files end with `~` (never produced by the encoding), so a key can coexist with a
 * longer key that uses it as a "directory" ("a/b" and "a/b/c"), as object stores allow.
 */
const OBJECT_SUFFIX = "~";

function encodeSegment(segment: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(segment)) {
    const char = String.fromCharCode(byte);
    out += /[a-z0-9._-]/.test(char) ? char : `%${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

function decodeSegment(name: string): string | null {
  if (!/^(?:[a-z0-9._-]|%[0-9a-f]{2})*$/.test(name)) return null;
  try {
    return decodeURIComponent(name);
  } catch {
    return null;
  }
}

interface StoredMeta {
  key: string;
  size: number;
  etag: string;
  contentType: string;
  cacheControl: string | null;
  uploadedAt: number;
  customMetadata: Record<string, string>;
  /** Identity of the data file this sidecar describes; a mismatch means the sidecar is stale. */
  file: { ino: number; size: number; mtimeMs: number };
}

interface FileIdentity {
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface FsBlobStoreOptions {
  /** Directory holding `data/` (objects), `meta/` (sidecar metadata) and `tmp/`. */
  root: string;
  clock?: Clock;
}

/**
 * `BlobStore` on the local filesystem (dev mode). Writes go to `tmp/` and are renamed into
 * place, so readers never see partial objects. Metadata lives in JSON sidecars under `meta/`;
 * an object without one (a file copied in by hand as `data/<key>~`) gets inferred metadata.
 */
export function createFsBlobStore(options: FsBlobStoreOptions): BlobStore {
  const root = resolve(options.root);
  const dataRoot = join(root, "data");
  const metaRoot = join(root, "meta");
  const tmpRoot = join(root, "tmp");
  const clock = options.clock ?? systemClock;

  const locate = (key: string) => {
    assertBlobKey(key);
    const relativePath = `${key.split("/").map(encodeSegment).join(sep)}${OBJECT_SUFFIX}`;
    const data = join(dataRoot, relativePath);
    // Defence in depth: assertBlobKey already rules out traversal.
    if (!data.startsWith(dataRoot + sep)) throw new Error(`Blob key escapes the root: ${key}`);
    return { data, meta: `${join(metaRoot, relativePath)}.json` };
  };

  const readMeta = async (
    key: string,
    metaPath: string,
    file: FileIdentity,
  ): Promise<BlobMetadata> => {
    const { size, mtimeMs } = file;
    let stored: StoredMeta | undefined;
    try {
      stored = JSON.parse(await readFile(metaPath, "utf8")) as StoredMeta;
    } catch {
      stored = undefined;
    }
    // Trust the sidecar only if it describes exactly this file. Otherwise (a put interrupted
    // between its two renames, a file copied in by hand) infer metadata from the file itself.
    if (
      stored?.file &&
      stored.file.ino === file.ino &&
      stored.file.size === size &&
      stored.file.mtimeMs === mtimeMs
    ) {
      const { file: _file, ...meta } = stored;
      return { ...meta, key };
    }
    return {
      key,
      size,
      etag: `${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}`,
      contentType: contentTypeForKey(key),
      cacheControl: null,
      uploadedAt: Math.floor(mtimeMs),
      customMetadata: {},
    } satisfies BlobMetadata;
  };

  const writeAtomically = async (target: string, write: (temp: string) => Promise<void>) => {
    await mkdir(tmpRoot, { recursive: true });
    const temp = join(tmpRoot, randomUUID());
    try {
      await write(temp);
      await mkdir(dirname(target), { recursive: true });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  };

  const isMissing = (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR");

  async function head(key: string): Promise<BlobMetadata | null> {
    const paths = locate(key);
    try {
      const stats = await stat(paths.data);
      if (!stats.isFile()) return null;
      return await readMeta(key, paths.meta, stats);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async function get(
    key: string,
    getOptions: { range?: BlobRange } = {},
  ): Promise<BlobObject | null> {
    const paths = locate(key);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(paths.data, "r");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      // Stat through the handle: a concurrent rename cannot swap the file under us.
      const stats = await handle.stat();
      const meta = await readMeta(key, paths.meta, stats);
      const range = getOptions.range ? resolveBlobRange(getOptions.range, stats.size) : null;
      if (stats.size === 0) {
        await handle.close();
        return { ...meta, body: bytesToStream(new Uint8Array(0)), range };
      }
      const stream = handle.createReadStream(
        range ? { start: range.offset, end: range.offset + range.length - 1 } : {},
      );
      return { ...meta, body: Readable.toWeb(stream) as ReadableStream<Uint8Array>, range };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async function put(
    key: string,
    body: BlobBody,
    putOptions: BlobPutOptions = {},
  ): Promise<BlobMetadata> {
    const paths = locate(key);
    const hash = createHash("sha256");
    let size = 0;
    await writeAtomically(paths.data, async (temp) => {
      const source =
        typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer
          ? Readable.from([
              typeof body === "string" ? Buffer.from(body) : Buffer.from(body as ArrayBuffer),
            ])
          : Readable.fromWeb(body.stream as import("node:stream/web").ReadableStream<Uint8Array>);
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.byteLength;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(source, meter, createWriteStream(temp));
      if (typeof body === "object" && "stream" in body && size !== body.size) {
        throw new RangeError(`Stream produced ${size} bytes, declared ${body.size}`);
      }
    });
    const written = await stat(paths.data);
    const meta: BlobMetadata = {
      key,
      size,
      etag: hash.digest("hex").slice(0, 32),
      contentType: putOptions.contentType ?? contentTypeForKey(key),
      cacheControl: putOptions.cacheControl ?? null,
      uploadedAt: clock.now(),
      customMetadata: { ...putOptions.customMetadata },
    };
    const stored: StoredMeta = {
      ...meta,
      file: { ino: written.ino, size: written.size, mtimeMs: written.mtimeMs },
    };
    await writeAtomically(paths.meta, (temp) => writeFile(temp, JSON.stringify(stored)));
    return meta;
  }

  async function remove(keys: string | readonly string[]): Promise<void> {
    for (const key of normalizeDeleteKeys(keys)) {
      const paths = locate(key);
      await rm(paths.data, { force: true });
      await rm(paths.meta, { force: true });
    }
  }

  async function walk(directory: string, into: string[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, into);
      else if (entry.isFile() && entry.name.endsWith(OBJECT_SUFFIX)) {
        const segments = relative(dataRoot, path.slice(0, -OBJECT_SUFFIX.length))
          .split(sep)
          .map(decodeSegment);
        if (segments.every((segment): segment is string => segment !== null)) {
          into.push(segments.join("/"));
        }
      }
    }
  }

  async function list(listOptions: BlobListOptions = {}): Promise<BlobListPage> {
    const limit = resolveListLimit(listOptions);
    const prefix = listOptions.prefix ?? "";
    // Only walk the directory the prefix pins down.
    const fixed = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
    const start = fixed ? join(dataRoot, ...fixed.split("/").map(encodeSegment)) : dataRoot;
    const keys: string[] = [];
    await walk(start, keys);
    const matching = keys
      .filter((key) => key.startsWith(prefix))
      .filter(
        (key) => listOptions.cursor === undefined || compareBlobKeys(key, listOptions.cursor) > 0,
      )
      .sort(compareBlobKeys);
    const page = matching.slice(0, limit);
    const items: BlobListItem[] = [];
    for (const key of page) {
      const meta = await head(key);
      if (meta) items.push({ key, size: meta.size, etag: meta.etag, uploadedAt: meta.uploadedAt });
    }
    const last = page[page.length - 1];
    return { items, cursor: matching.length > limit && last !== undefined ? last : null };
  }

  return { head, get, put, delete: remove, list };
}
