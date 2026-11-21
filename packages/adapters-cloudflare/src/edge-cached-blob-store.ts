import {
  assertBlobKey,
  type BlobMetadata,
  type BlobObject,
  type BlobRange,
  BlobRangeNotSatisfiableError,
  type BlobStore,
  type Logger,
  noopLogger,
  parseHttpRange,
} from "@webflix/core";

/**
 * Reading blobs through the Workers edge cache, safely.
 *
 * Protected media URLs carry a per-session token (`/media/{token}/vod/...`), so caching the
 * public URL would give every session its own cache entry (no sharing) and caching without the
 * token would skip authorisation. The split used here, Cloudflare's "authorise in a gateway,
 * cache in a named entrypoint" pattern:
 *
 * 1. The gateway (the Worker's default `fetch`, never cached) runs the whole HTTP app: session,
 *    media token, stream-slot check for playlists. Only then does it read the blob, through
 *    the `BlobStore` built here.
 * 2. Reads become `fetch`es to a cache-enabled entrypoint (`MediaOrigin`, via `ctx.exports`),
 *    at a token-free internal URL: `/{generation}/{blob key}`. Every session watching the same
 *    segment shares one edge entry, tiered and request-collapsed by the platform.
 * 3. The origin answers with the whole object (`serveBlobOrigin`); the cache stores it and
 *    slices `Range` requests itself. Where no cache sits in between (local `wrangler dev`, a
 *    plain service binding) the origin sees the `Range` header and answers 206 on its own, so
 *    the gateway code path is identical everywhere.
 * 4. `generation` is part of every internal URL. Blob keys are not content-addressed
 *    (re-packaging an asset rewrites `vod/{asset}/...` in place), so the media upload switches
 *    the cache off (null) before it rewrites anything and to a new generation after the last
 *    object, and reads never cache a mix of old and new bytes.
 *
 * Writes, `head` and `list` go straight to the store: they are rare, and `head` must be fresh.
 */

/** Internal header carrying the port's metadata across the cache (ASCII-safe JSON). */
const META_HEADER = "X-Webflix-Blob";

type WireMetadata = Omit<BlobMetadata, "key">;

export interface BlobOriginOptions {
  /** `Cache-Control` for the edge cache on a 200. */
  cacheControl: string;
  /** Optional `Cache-Tag` so the whole media cache can be purged by tag. */
  cacheTag?: string;
}

/** Encode a blob key as URL path segments (keys may contain spaces and any Unicode). */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * `/{generation}/{encoded key}` → the key, or null when the path is not one we produce. The
 * generation segment only partitions the cache; the origin ignores it.
 */
export function blobKeyFromOriginPath(pathname: string): string | null {
  const rest = pathname.split("/").slice(2);
  if (rest.length === 0) return null;
  try {
    const key = rest.map(decodeURIComponent).join("/");
    assertBlobKey(key);
    return key;
  } catch {
    return null;
  }
}

function plain(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/**
 * The origin side: answer an internal blob request from `store`. A `Range` header (present only
 * when no cache stripped it) is honoured with a 206; otherwise the whole object is returned with
 * a cacheable `Cache-Control` so the edge can store it and slice ranges from it.
 */
export async function serveBlobOrigin(
  store: BlobStore,
  request: Request,
  options: BlobOriginOptions,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405);
  const key = blobKeyFromOriginPath(new URL(request.url).pathname);
  if (!key) return plain(404);
  const range = parseHttpRange(request.headers.get("Range"));
  let object: BlobObject | null;
  try {
    object = await store.get(key, range ? { range } : {});
  } catch (error) {
    if (error instanceof BlobRangeNotSatisfiableError) {
      return plain(416, { "Content-Range": `bytes */${error.size}` });
    }
    throw error;
  }
  if (!object) return plain(404);

  const meta: WireMetadata = {
    size: object.size,
    etag: object.etag,
    contentType: object.contentType,
    cacheControl: object.cacheControl,
    uploadedAt: object.uploadedAt,
    customMetadata: object.customMetadata,
  };
  const headers = new Headers({
    "Content-Type": object.contentType,
    ETag: `"${object.etag}"`,
    "Last-Modified": new Date(object.uploadedAt).toUTCString(),
    "Accept-Ranges": "bytes",
    [META_HEADER]: encodeURIComponent(JSON.stringify(meta)),
  });
  if (object.range) {
    const end = object.range.offset + object.range.length - 1;
    headers.set("Content-Range", `bytes ${object.range.offset}-${end}/${object.size}`);
    headers.set("Content-Length", String(object.range.length));
    // A 206 is never stored by the cache; say so explicitly for any other cache in between.
    headers.set("Cache-Control", "no-store");
    return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", options.cacheControl);
  if (options.cacheTag) headers.set("Cache-Tag", options.cacheTag);
  if (request.method === "HEAD") {
    await object.body.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

/** Anything with a `fetch` (a `ctx.exports` entrypoint, a service binding, a test double). */
export interface BlobOrigin {
  fetch(request: Request): Promise<Response>;
}

export interface EdgeCachedBlobStoreOptions {
  /** The cache-enabled entrypoint that runs `serveBlobOrigin`. */
  origin: BlobOrigin;
  /** The real store (R2): writes, `head`, `list`, and the fallback for odd cache answers. */
  store: BlobStore;
  /**
   * Cache partition; changes whenever stored media is replaced in place. URL-path safe. Null
   * while media is being replaced: reads then go straight to the store and nothing is cached.
   */
  generation: () => string | null | Promise<string | null>;
  logger?: Logger;
}

const ORIGIN_BASE = "https://media-origin.internal";

function readMetadata(response: Response, key: string): BlobMetadata | null {
  const raw = response.headers.get(META_HEADER);
  if (!raw) return null;
  try {
    return { key, ...(JSON.parse(decodeURIComponent(raw)) as WireMetadata) };
  } catch {
    return null;
  }
}

/** `bytes 0-99/1000` → `{ offset: 0, length: 100 }`. */
function parseContentRange(header: string | null): { offset: number; length: number } | null {
  const match = header ? /^bytes (\d+)-(\d+)\/\d+$/.exec(header) : null;
  if (!match) return null;
  const start = Number(match[1]);
  return { offset: start, length: Number(match[2]) - start + 1 };
}

function sizeFromUnsatisfied(header: string | null): number | null {
  const match = header ? /^bytes \*\/(\d+)$/.exec(header) : null;
  return match ? Number(match[1]) : null;
}

/**
 * A `BlobStore` whose `get` goes through the edge cache (see the module comment). Same port
 * semantics as the store it wraps: ranges, 416s, metadata, missing keys.
 */
export function createEdgeCachedBlobStore(options: EdgeCachedBlobStoreOptions): BlobStore {
  const { origin, store } = options;
  const logger = options.logger ?? noopLogger;

  async function viaOrigin(key: string, range: BlobRange | undefined): Promise<BlobObject | null> {
    const generation = await options.generation();
    if (generation === null) return store.get(key, range ? { range } : {});
    const headers = new Headers();
    if (range) headers.set("Range", toHttpRange(range));
    const response = await origin.fetch(
      new Request(`${ORIGIN_BASE}/${generation}/${encodeKey(key)}`, { headers }),
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status === 416) {
      const size = sizeFromUnsatisfied(response.headers.get("Content-Range"));
      await response.body?.cancel();
      if (size !== null) throw new BlobRangeNotSatisfiableError(size);
    }
    const meta = readMetadata(response, key);
    const body = response.body;
    if (!meta || !body || (response.status !== 200 && response.status !== 206)) {
      await body?.cancel();
      throw new Error(`Blob origin answered ${response.status} for ${key}`);
    }
    if (response.status === 206) {
      const satisfied = parseContentRange(response.headers.get("Content-Range"));
      if (!satisfied) {
        await body.cancel();
        throw new Error(`Blob origin sent a 206 without a usable Content-Range for ${key}`);
      }
      return { ...meta, body, range: satisfied };
    }
    if (range) {
      // The whole object came back for a ranged read (a cache that does not slice). Rare:
      // read the range from the store directly rather than streaming bytes nobody wants.
      logger.debug("blob_cache.range_not_sliced", { key });
      await body.cancel();
      return store.get(key, { range });
    }
    return { ...meta, body, range: null };
  }

  return {
    head: (key) => store.head(key),
    async get(key, getOptions = {}) {
      assertBlobKey(key);
      return viaOrigin(key, getOptions.range);
    },
    put: (key, body, putOptions) => store.put(key, body, putOptions),
    delete: (keys) => store.delete(keys),
    list: (listOptions) => store.list(listOptions),
  };
}

function assertRangeNumbers(range: BlobRange): void {
  const values = "suffix" in range ? [range.suffix] : [range.offset, range.length ?? 0];
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Range offsets and lengths must be non-negative integers");
    }
  }
}

/** `BlobRange` → the equivalent single-range `Range` header. */
function toHttpRange(range: BlobRange): string {
  assertRangeNumbers(range);
  if ("suffix" in range) return `bytes=-${range.suffix}`;
  if (range.length === undefined) return `bytes=${range.offset}-`;
  // A zero length is unsatisfiable by the port's rules; `bytes=5-4` would be ignored by HTTP
  // parsers, so ask for the impossible range the origin will reject with the size.
  if (range.length === 0) return `bytes=${Number.MAX_SAFE_INTEGER}-`;
  return `bytes=${range.offset}-${range.offset + range.length - 1}`;
}
