import { blobKeyProblem } from "@webflix/contracts";
import { utf8Encode } from "../encoding.ts";

export interface BlobMetadata {
  key: string;
  /** Total object size in bytes (not the size of a requested range). */
  size: number;
  /** Opaque, unquoted; changes whenever the content changes. Quote it for HTTP `ETag`. */
  etag: string;
  contentType: string;
  cacheControl: string | null;
  /** Epoch milliseconds. */
  uploadedAt: number;
  customMetadata: Record<string, string>;
}

/**
 * Byte range, mirroring R2's `R2Range`. `{ offset, length }` reads `length` bytes from
 * `offset` (clamped to the end), `{ offset }` reads to the end, `{ suffix }` reads the last
 * `suffix` bytes (the whole object when larger).
 */
export type BlobRange = { offset: number; length?: number } | { suffix: number };

export interface BlobObject extends BlobMetadata {
  /** Exactly the requested bytes. Consume or cancel it. */
  body: ReadableStream<Uint8Array>;
  /** The satisfied range in absolute bytes, or null when the whole object was requested. */
  range: { offset: number; length: number } | null;
}

/**
 * What `put` accepts. Streams must declare their size: R2 and S3 both need a known length,
 * so an unknown-length stream is not portable.
 */
export type BlobBody =
  | Uint8Array<ArrayBuffer>
  | ArrayBuffer
  | string
  | { stream: ReadableStream<Uint8Array>; size: number };

export interface BlobPutOptions {
  /** Defaults to `contentTypeForKey(key)`. */
  contentType?: string;
  cacheControl?: string;
  customMetadata?: Record<string, string>;
}

export const MAX_BLOB_LIST_LIMIT = 1000;
export const MAX_BLOB_DELETE_BATCH = 1000;
export { MAX_BLOB_KEY_BYTES } from "@webflix/contracts";

export interface BlobListOptions {
  prefix?: string;
  /** Opaque cursor from a previous page. */
  cursor?: string;
  /** 1..1000, default 1000. */
  limit?: number;
}

/**
 * What a listing returns per object: only what S3 `ListObjectsV2` and R2 `list()` both
 * provide without a per-object HEAD. Call `head` for content type and custom metadata.
 */
export type BlobListItem = Pick<BlobMetadata, "key" | "size" | "etag" | "uploadedAt">;

export interface BlobListPage {
  /** Ordered by key (Unicode code point order, i.e. UTF-8 byte order). */
  items: BlobListItem[];
  /** Null on the last page. */
  cursor: string | null;
}

/**
 * Port: object storage (filesystem / S3 API / R2 binding), one bucket (blueprint §2.5).
 *
 * Contract (see `describeBlobStoreContract`):
 * - Keys are validated by `assertBlobKey` in every adapter (no traversal, no leading slash).
 * - `get`/`head` of a missing key return null. `delete` is idempotent and accepts up to 1000 keys.
 * - Range reads follow `BlobRange`; an unsatisfiable range (empty object, offset >= size)
 *   throws `BlobRangeNotSatisfiableError` carrying the object size (HTTP 416).
 * - `put` replaces atomically: readers see the old or the new object, never a mix.
 * - `list` pages are ordered by key; following cursors yields every key exactly once.
 */
export interface BlobStore {
  head(key: string): Promise<BlobMetadata | null>;
  get(key: string, options?: { range?: BlobRange }): Promise<BlobObject | null>;
  put(key: string, body: BlobBody, options?: BlobPutOptions): Promise<BlobMetadata>;
  delete(keys: string | readonly string[]): Promise<void>;
  list(options?: BlobListOptions): Promise<BlobListPage>;
}

export class InvalidBlobKeyError extends TypeError {
  override readonly name = "InvalidBlobKeyError";
  readonly key: string;

  constructor(key: string, reason: string) {
    super(`Invalid blob key ${JSON.stringify(key)}: ${reason}`);
    this.key = key;
  }
}

export class BlobRangeNotSatisfiableError extends RangeError {
  override readonly name = "BlobRangeNotSatisfiableError";
  /** Total object size, for `Content-Range: bytes *\/<size>`. */
  readonly size: number;

  constructor(size: number) {
    super(`Range not satisfiable for an object of ${size} bytes`);
    this.size = size;
  }
}

/** Shared key rules (`blobKeyProblem`); adapters call this before touching storage. */
export function assertBlobKey(key: string): void {
  const problem = blobKeyProblem(key);
  if (problem !== null) throw new InvalidBlobKeyError(key, problem);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

/** Resolve a `BlobRange` against an object size; throws when unsatisfiable. */
export function resolveBlobRange(
  range: BlobRange,
  size: number,
): { offset: number; length: number } {
  if ("suffix" in range) {
    assertNonNegativeInteger(range.suffix, "suffix");
    if (range.suffix === 0 || size === 0) throw new BlobRangeNotSatisfiableError(size);
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  assertNonNegativeInteger(range.offset, "offset");
  if (range.length !== undefined) {
    assertNonNegativeInteger(range.length, "length");
    if (range.length === 0) throw new BlobRangeNotSatisfiableError(size);
  }
  if (range.offset >= size) throw new BlobRangeNotSatisfiableError(size);
  const available = size - range.offset;
  return { offset: range.offset, length: Math.min(range.length ?? available, available) };
}

/**
 * Parse a single-range HTTP `Range` header (`bytes=0-499`, `bytes=500-`, `bytes=-500`).
 * Returns null for anything else (multi-range, other units, malformed): serve the full object.
 */
export function parseHttpRange(header: string | null | undefined): BlobRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, start = "", end = ""] = match;
  if (start === "" && end === "") return null;
  // Absurdly large numbers are clamped rather than turned into a 500: an end past the object
  // means "to the end"; a suffix longer than the object means "the whole object".
  if (start === "") return { suffix: Math.min(Number(end), Number.MAX_SAFE_INTEGER) };
  const offset = Number(start);
  if (!Number.isSafeInteger(offset)) return { offset: Number.MAX_SAFE_INTEGER };
  if (end === "") return { offset };
  const last = Number(end);
  if (!Number.isSafeInteger(last)) return { offset };
  if (last < offset) return null;
  return { offset, length: last - offset + 1 };
}

const CONTENT_TYPES: Record<string, string> = {
  m3u8: "application/vnd.apple.mpegurl",
  m4s: "video/iso.segment",
  mp4: "video/mp4",
  m4a: "audio/mp4",
  ts: "video/mp2t",
  aac: "audio/aac",
  vtt: "text/vtt; charset=utf-8",
  avif: "image/avif",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
};

/** Content type for a key by extension; `application/octet-stream` when unknown. */
export function contentTypeForKey(key: string): string {
  const dot = key.lastIndexOf(".");
  const extension = dot === -1 ? "" : key.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/** Byte comparison in UTF-8 order (code point order), the order `list` must use. */
export function compareBlobKeys(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** Normalise any `BlobBody` to bytes (adapters that buffer, e.g. memory). */
export async function blobBodyToBytes(body: BlobBody): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof body === "string") return utf8Encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  const bytes = new Uint8Array(await new Response(body.stream).arrayBuffer());
  if (bytes.byteLength !== body.size) {
    throw new RangeError(`Stream produced ${bytes.byteLength} bytes, declared ${body.size}`);
  }
  return bytes;
}

/** A one-chunk stream over `bytes`. */
export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Validates `limit` (1..1000) and returns it, defaulting to 1000. */
export function resolveListLimit(options: BlobListOptions): number {
  const limit = options.limit ?? MAX_BLOB_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BLOB_LIST_LIMIT) {
    throw new RangeError(`list limit must be an integer in 1..${MAX_BLOB_LIST_LIMIT}`);
  }
  return limit;
}

/** Validates a `delete` argument (keys and batch size) and returns it as a list. */
export function normalizeDeleteKeys(keys: string | readonly string[]): readonly string[] {
  const list = typeof keys === "string" ? [keys] : keys;
  if (list.length > MAX_BLOB_DELETE_BATCH) {
    throw new RangeError(`At most ${MAX_BLOB_DELETE_BATCH} keys per delete`);
  }
  for (const key of list) assertBlobKey(key);
  return list;
}

/**
 * A view of `store` under `prefix` (keys are relative to it). Lets contract tests and tools
 * share one real bucket without colliding.
 */
export function scopeBlobStore(store: BlobStore, prefix: string): BlobStore {
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  assertBlobKey(normalized.slice(0, -1));
  const strip = <T extends BlobListItem>(meta: T): T => ({
    ...meta,
    key: meta.key.slice(normalized.length),
  });
  const full = (key: string) => {
    assertBlobKey(key);
    return `${normalized}${key}`;
  };
  return {
    head: async (key) => {
      const meta = await store.head(full(key));
      return meta && strip(meta);
    },
    get: async (key, options) => {
      const object = await store.get(full(key), options);
      return object && strip(object);
    },
    put: async (key, body, options) => strip(await store.put(full(key), body, options)),
    // async so validation failures reject rather than throw synchronously, like every method.
    delete: async (keys) => store.delete(typeof keys === "string" ? full(keys) : keys.map(full)),
    list: async (options = {}) => {
      const page = await store.list({ ...options, prefix: `${normalized}${options.prefix ?? ""}` });
      return { items: page.items.map(strip), cursor: page.cursor };
    },
  };
}
