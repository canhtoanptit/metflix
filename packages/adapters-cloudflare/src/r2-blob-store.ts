import {
  assertBlobKey,
  type BlobBody,
  type BlobListItem,
  type BlobMetadata,
  type BlobRange,
  type BlobStore,
  blobBodyToBytes,
  contentTypeForKey,
  normalizeDeleteKeys,
  resolveBlobRange,
  resolveListLimit,
} from "@webflix/core";

/**
 * `BlobStore` on an R2 bucket binding (blueprint §2.5: one bucket, `webflix-media`).
 *
 * Mapping:
 * - Ranges are R2 ranges (the port mirrors `R2Range`). The satisfied range is recomputed with
 *   the shared `resolveBlobRange`, and unsatisfiable ranges are detected before R2 is asked for
 *   bytes when the size is known, so every mode answers 416 identically.
 * - `put` streams: a sized stream goes through a `FixedLengthStream`, which is what lets R2
 *   accept a stream at all, and which errors (failing the put, storing nothing) when the source
 *   produces a different number of bytes than declared. R2 writes are atomic per object.
 * - `etag` is R2's unquoted etag; content type and Cache-Control live in `httpMetadata`.
 * - `list` is R2's lexicographic (UTF-8 byte) listing; items carry no metadata (R2 omits it
 *   unless asked, and S3 cannot provide it), matching the port.
 */
export function createR2BlobStore(bucket: R2Bucket): BlobStore {
  return {
    async head(key) {
      assertBlobKey(key);
      const object = await bucket.head(key);
      return object && toMetadata(object);
    },

    async get(key, options = {}) {
      assertBlobKey(key);
      const range = options.range;
      if (!range) {
        const object = await bucket.get(key);
        return object && { ...toMetadata(object), body: object.body, range: null };
      }
      let object: R2ObjectBody | null;
      try {
        object = await bucket.get(key, { range: toR2Range(range) });
      } catch (error) {
        // R2 rejects ranges that start past the end. Report it the portable way, with the size.
        const meta = await bucket.head(key);
        if (meta) resolveBlobRange(range, meta.size);
        throw error;
      }
      if (!object) return null;
      let resolved: { offset: number; length: number };
      try {
        resolved = resolveBlobRange(range, object.size);
      } catch (error) {
        // An empty object "satisfies" any range in R2; the port says 416.
        await object.body.cancel();
        throw error;
      }
      return { ...toMetadata(object), body: object.body, range: resolved };
    },

    async put(key, body, options = {}) {
      assertBlobKey(key);
      const putOptions: R2PutOptions = {
        httpMetadata: {
          contentType: options.contentType ?? contentTypeForKey(key),
          ...(options.cacheControl ? { cacheControl: options.cacheControl } : {}),
        },
        customMetadata: { ...options.customMetadata },
      };
      if (!isSizedStream(body)) {
        return toMetadata(await bucket.put(key, toR2Value(body), putOptions));
      }
      if (!Number.isSafeInteger(body.size) || body.size < 0) {
        throw new RangeError("A streamed blob must declare a non-negative integer size");
      }
      if (typeof FixedLengthStream !== "function") {
        // Outside workerd (a Node script on a `getPlatformProxy` binding) there is no
        // FixedLengthStream; buffer instead, still checking the declared size.
        return toMetadata(await bucket.put(key, await blobBodyToBytes(body), putOptions));
      }
      const fixed = new FixedLengthStream(body.size);
      // The pipe and the upload fail together when the byte count is wrong; await both so
      // neither rejection goes unobserved.
      const piping = body.stream.pipeTo(fixed.writable);
      const [stored] = await Promise.all([bucket.put(key, fixed.readable, putOptions), piping]);
      return toMetadata(stored);
    },

    async delete(keys) {
      const list = normalizeDeleteKeys(keys);
      if (list.length > 0) await bucket.delete([...list]);
    },

    async list(options = {}) {
      const limit = resolveListLimit(options);
      const page = await bucket.list({
        limit,
        ...(options.prefix ? { prefix: options.prefix } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
      });
      return {
        items: page.objects.map(
          (object): BlobListItem => ({
            key: object.key,
            size: object.size,
            etag: object.etag,
            uploadedAt: object.uploaded.getTime(),
          }),
        ),
        cursor: page.truncated ? page.cursor : null,
      };
    },
  };
}

function toMetadata(object: R2Object): BlobMetadata {
  return {
    key: object.key,
    size: object.size,
    etag: object.etag,
    contentType: object.httpMetadata?.contentType ?? contentTypeForKey(object.key),
    cacheControl: object.httpMetadata?.cacheControl ?? null,
    uploadedAt: object.uploaded.getTime(),
    customMetadata: { ...object.customMetadata },
  };
}

function toR2Range(range: BlobRange): R2Range {
  if ("suffix" in range) return { suffix: range.suffix };
  return range.length === undefined
    ? { offset: range.offset }
    : { offset: range.offset, length: range.length };
}

type SizedStream = Extract<BlobBody, { stream: ReadableStream<Uint8Array> }>;

function isSizedStream(body: BlobBody): body is SizedStream {
  return typeof body === "object" && body !== null && "stream" in body;
}

function toR2Value(body: Exclude<BlobBody, SizedStream>): ArrayBuffer | ArrayBufferView | string {
  return body;
}
