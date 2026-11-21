import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import {
  AppError,
  assertBlobKey,
  type BlobBody,
  type BlobListPage,
  type BlobMetadata,
  type BlobObject,
  type BlobPutOptions,
  type BlobRange,
  BlobRangeNotSatisfiableError,
  type BlobStore,
  contentTypeForKey,
  normalizeDeleteKeys,
  resolveBlobRange,
  resolveListLimit,
  utf8Encode,
} from "@webflix/core";

export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for S3-compatible stores (Garage, RustFS, Ceph RGW, R2's S3 API). */
  endpoint?: string | null;
  /**
   * Static credentials. When absent the AWS default chain applies (environment, web identity
   * / IRSA / EKS Pod Identity, instance metadata), which is what a managed cluster should use.
   */
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  /** Path-style URLs (`endpoint/bucket/key`); needed by most self-hosted stores. */
  forcePathStyle?: boolean;
  /** Socket connect timeout (default 3000 ms). */
  connectionTimeoutMs?: number;
  /**
   * Deadline for a metadata operation (head, list, delete, ping) and for the response headers
   * of a get, retries included (default 10 000 ms). Uploads get this plus time for their size.
   */
  requestTimeoutMs?: number;
  /**
   * A get body that delivers nothing for this long while it is being read fails (default
   * 15 000 ms). Counted only while the reader waits for the store, so a slow client that
   * applies backpressure never trips it: this bounds stalls, not transfer time.
   */
  bodyIdleTimeoutMs?: number;
  /** Concurrent connections to the store (default 256; Node's agent alone would queue). */
  maxSockets?: number;
  maxAttempts?: number;
}

export interface S3BlobStore extends BlobStore {
  /** Readiness / bootstrap: the bucket exists and the credentials can reach it. */
  ping(): Promise<void>;
  destroy(): void;
}

/** Custom metadata that is not plain lowercase ASCII travels as one JSON header. */
const META_JSON = "webflix-json";
const SIMPLE_META_KEY = /^[a-z0-9][a-z0-9_-]*$/;
const SIMPLE_META_VALUE = /^[\x20-\x7e]*$/;

function encodeMetadata(metadata: Record<string, string>): Record<string, string> {
  const entries = Object.entries(metadata);
  if (
    entries.every(
      ([key, value]) =>
        SIMPLE_META_KEY.test(key) && key !== META_JSON && SIMPLE_META_VALUE.test(value),
    )
  ) {
    return Object.fromEntries(entries);
  }
  // S3 lower-cases metadata keys and mangles non-ASCII values; keep them exactly.
  return { [META_JSON]: Buffer.from(JSON.stringify(metadata)).toString("base64url") };
}

function decodeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  if (!metadata) return {};
  const packed = metadata[META_JSON];
  if (packed === undefined) return { ...metadata };
  try {
    return JSON.parse(Buffer.from(packed, "base64url").toString("utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

const stripQuotes = (etag: string | undefined) =>
  (etag ?? "").replace(/^W\//, "").replace(/"/g, "");

function errorStatus(error: unknown): number | undefined {
  if (error instanceof S3ServiceException) return error.$metadata.httpStatusCode;
  if (typeof error === "object" && error !== null && "$metadata" in error) {
    return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  }
  return undefined;
}

const isNotFound = (error: unknown) =>
  errorStatus(error) === 404 ||
  (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"));

function rangeHeader(range: BlobRange): string {
  if ("suffix" in range) return `bytes=-${range.suffix}`;
  if (range.length === undefined) return `bytes=${range.offset}-`;
  return `bytes=${range.offset}-${range.offset + range.length - 1}`;
}

/** `bytes 100-149/1000` → offset, length, total. */
function parseContentRange(header: string | undefined) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header ?? "");
  if (!match) return null;
  const [, start = "0", end = "0", total = "0"] = match;
  return { offset: Number(start), length: Number(end) - Number(start) + 1, size: Number(total) };
}

/** A web stream of exactly `length` bytes starting `skip` bytes into `source`. */
function sliceStream(
  source: ReadableStream<Uint8Array>,
  skip: number,
  length: number,
): ReadableStream<Uint8Array> {
  let position = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const start = Math.max(0, skip - position);
        const end = Math.min(chunk.byteLength, skip + length - position);
        position += chunk.byteLength;
        if (end > start) controller.enqueue(chunk.subarray(start, end));
      },
    }),
  );
}

/** Fails the upload (so S3 never commits the object) if the stream's size is not as declared. */
function sizeChecked(stream: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > size) {
          controller.error(new RangeError(`Stream produced more than the declared ${size} bytes`));
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== size) {
          controller.error(new RangeError(`Stream produced ${seen} bytes, declared ${size}`));
        }
      },
    }),
  );
}

/** Uploads must progress at least this fast on average (their deadline grows with size). */
const MIN_UPLOAD_BYTES_PER_SEC = 256 * 1024;

class StoreTimeoutError extends Error {
  override readonly name = "TimeoutError";
}

/** The store is unreachable, stalled or overloaded: a 503 for the caller, not a 500. */
function isStoreUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof StoreTimeoutError || error.name === "TimeoutError") return true;
  if (error.name === "AbortError") return true;
  const code = (error as { code?: string }).code;
  if (
    code &&
    /^(ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)$/.test(
      code,
    )
  )
    return true;
  const status = errorStatus(error);
  return status === 500 || status === 502 || status === 503 || status === 504;
}

function unavailable(operation: string, error: unknown): unknown {
  return isStoreUnavailable(error)
    ? new AppError("service_unavailable", {
        detail: `Media storage is temporarily unavailable (${operation})`,
        cause: error,
      })
    : error;
}

/**
 * A stream that fails when the store delivers nothing for `idleMs` while the consumer waits
 * for data. Pulled on demand only (high-water mark 0), so a consumer that stops reading
 * (backpressure from a slow client) never starts the clock.
 */
function idleGuarded(
  source: ReadableStream<Uint8Array>,
  idleMs: number,
  onStall: (error: Error) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stalled = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new StoreTimeoutError(`No bytes from the object store for ${idleMs} ms`)),
            idleMs,
          );
        });
        try {
          const chunk = await Promise.race([reader.read(), stalled]);
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          onStall(failure);
          reader.cancel(failure).catch(() => {});
          controller.error(failure);
        } finally {
          clearTimeout(timer);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * `BlobStore` over the S3 API: AWS S3 or any compatible store. One bucket (blueprint §2.5).
 *
 * - `put` is a single PutObject with a known length; S3 commits an object only when the whole
 *   body arrived, which gives the port's atomic replace. A stream that does not match its
 *   declared size aborts the request, so nothing is written.
 * - Ranged `get` is one GetObject with a `Range` header; the size comes from `Content-Range`.
 *   Unsatisfiable ranges cost one extra HEAD to report the size (rare: HTTP 416 paths only).
 * - `list` is ListObjectsV2 (UTF-8 byte order = code point order); the cursor is the last key.
 * - Checksums are sent only where S3 requires them: several S3-compatible stores reject the
 *   SDK's default trailing CRC32 checksums.
 * - Every call has a deadline (the SDK's own request timeout only logs a warning, and its
 *   socket timeout would also kill a healthy transfer paused by a slow client): metadata calls
 *   and a get's headers within `requestTimeoutMs`, a get's body must not stall for
 *   `bodyIdleTimeoutMs`. A stalled, unreachable or overloaded store surfaces as
 *   `service_unavailable` (503), never as a request hanging until the gateway gives up.
 */
export function createS3BlobStore(options: S3BlobStoreOptions): S3BlobStore {
  const maxSockets = options.maxSockets ?? 256;
  const httpAgent = new HttpAgent({ keepAlive: true, maxSockets });
  const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets });
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    forcePathStyle: options.forcePathStyle ?? true,
    ...(options.accessKeyId && options.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }
      : {}),
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: options.maxAttempts ?? 3,
    requestHandler: {
      connectionTimeout: options.connectionTimeoutMs ?? 3000,
      httpAgent,
      httpsAgent,
    },
  });
  const Bucket = options.bucket;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const bodyIdleTimeoutMs = options.bodyIdleTimeoutMs ?? 15_000;

  /** Run `send` with a deadline; on expiry the request is aborted and a timeout thrown. */
  async function within<T>(
    operation: string,
    ms: number,
    send: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new StoreTimeoutError(`${operation} took longer than ${ms} ms`)),
      ms,
    );
    try {
      return await send(controller.signal);
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function head(key: string): Promise<BlobMetadata | null> {
    assertBlobKey(key);
    try {
      const result = await within("head", requestTimeoutMs, (abortSignal) =>
        client.send(new HeadObjectCommand({ Bucket, Key: key }), { abortSignal }),
      );
      return {
        key,
        size: result.ContentLength ?? 0,
        etag: stripQuotes(result.ETag),
        contentType: result.ContentType ?? contentTypeForKey(key),
        cacheControl: result.CacheControl ?? null,
        uploadedAt: result.LastModified?.getTime() ?? 0,
        customMetadata: decodeMetadata(result.Metadata),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw unavailable("head", error);
    }
  }

  async function unsatisfiable(key: string, range: BlobRange): Promise<null> {
    const meta = await head(key);
    if (!meta) return null;
    resolveBlobRange(range, meta.size); // throws BlobRangeNotSatisfiableError with the size
    throw new BlobRangeNotSatisfiableError(meta.size);
  }

  async function get(
    key: string,
    getOptions: { range?: BlobRange } = {},
  ): Promise<BlobObject | null> {
    assertBlobKey(key);
    const range = getOptions.range;
    // `bytes=-0` and zero-length ranges are not valid HTTP ranges: resolve them against the size.
    if (
      range &&
      (("suffix" in range && range.suffix === 0) || ("length" in range && range.length === 0))
    ) {
      return unsatisfiable(key, range);
    }
    // One controller for the whole exchange: the headers deadline, then the body watchdog.
    const controller = new AbortController();
    const headersTimer = setTimeout(
      () =>
        controller.abort(
          new StoreTimeoutError(`get: no response headers within ${requestTimeoutMs} ms`),
        ),
      requestTimeoutMs,
    );
    let result: GetObjectCommandOutput;
    try {
      result = await client.send(
        new GetObjectCommand({ Bucket, Key: key, ...(range ? { Range: rangeHeader(range) } : {}) }),
        { abortSignal: controller.signal },
      );
    } catch (error) {
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      if (isNotFound(failure)) return null;
      if (range && errorStatus(failure) === 416) return unsatisfiable(key, range);
      throw unavailable("get", failure);
    } finally {
      clearTimeout(headersTimer);
    }
    const raw =
      (result.Body?.transformToWebStream() as ReadableStream<Uint8Array> | undefined) ??
      new Response(new Uint8Array(0)).body;
    if (!raw) throw new Error("S3 returned no body");
    const body = idleGuarded(raw, bodyIdleTimeoutMs, (error) => controller.abort(error));
    const meta = {
      key,
      etag: stripQuotes(result.ETag),
      contentType: result.ContentType ?? contentTypeForKey(key),
      cacheControl: result.CacheControl ?? null,
      uploadedAt: result.LastModified?.getTime() ?? 0,
      customMetadata: decodeMetadata(result.Metadata),
    };
    if (!range) {
      return { ...meta, size: result.ContentLength ?? 0, range: null, body };
    }
    const partial = parseContentRange(result.ContentRange);
    if (partial) {
      // Validate against the size rather than trusting the store: some answer a suffix range
      // on an empty object with 206 and a nonsensical Content-Range.
      let expected: { offset: number; length: number };
      try {
        expected = resolveBlobRange(range, partial.size);
      } catch (error) {
        await body.cancel();
        throw error;
      }
      if (expected.offset !== partial.offset || expected.length !== partial.length) {
        await body.cancel();
        throw new Error(
          `S3 answered range ${partial.offset}+${partial.length} for ${rangeHeader(range)} of ${partial.size} bytes`,
        );
      }
      return { ...meta, size: partial.size, range: expected, body };
    }
    // The store ignored the range (some do for empty objects): resolve and slice here.
    const size = result.ContentLength ?? 0;
    let resolved: { offset: number; length: number };
    try {
      resolved = resolveBlobRange(range, size);
    } catch (error) {
      await body.cancel();
      throw error;
    }
    return {
      ...meta,
      size,
      range: resolved,
      body: sliceStream(body, resolved.offset, resolved.length),
    };
  }

  async function put(
    key: string,
    body: BlobBody,
    putOptions: BlobPutOptions = {},
  ): Promise<BlobMetadata> {
    assertBlobKey(key);
    let payload: Uint8Array | Readable;
    let size: number;
    if (typeof body === "string") {
      payload = utf8Encode(body);
      size = payload.byteLength;
    } else if (body instanceof Uint8Array) {
      payload = body;
      size = body.byteLength;
    } else if (body instanceof ArrayBuffer) {
      payload = new Uint8Array(body);
      size = body.byteLength;
    } else {
      size = body.size;
      payload = Readable.fromWeb(
        sizeChecked(body.stream, body.size) as import("node:stream/web").ReadableStream<Uint8Array>,
      );
    }
    // A body stream that fails (wrong size, source error) must abort the request: S3 then
    // never commits the object. Without this the request would wait for the missing bytes.
    const abort = new AbortController();
    let bodyError: unknown;
    if (payload instanceof Readable) {
      payload.once("error", (error) => {
        bodyError = error;
        abort.abort(error);
      });
    }
    const contentType = putOptions.contentType ?? contentTypeForKey(key);
    const customMetadata = { ...putOptions.customMetadata };
    let result: { ETag?: string };
    const deadlineMs = requestTimeoutMs + Math.ceil((size / MIN_UPLOAD_BYTES_PER_SEC) * 1000);
    const deadline = setTimeout(
      () =>
        abort.abort(
          new StoreTimeoutError(`put of ${size} bytes took longer than ${deadlineMs} ms`),
        ),
      deadlineMs,
    );
    try {
      result = await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: payload,
          ContentLength: size,
          ContentType: contentType,
          ...(putOptions.cacheControl ? { CacheControl: putOptions.cacheControl } : {}),
          Metadata: encodeMetadata(customMetadata),
        }),
        { abortSignal: abort.signal },
      );
    } catch (error) {
      throw bodyError ?? unavailable("put", abort.signal.aborted ? abort.signal.reason : error);
    } finally {
      clearTimeout(deadline);
    }
    return {
      key,
      size,
      etag: stripQuotes(result.ETag),
      contentType,
      cacheControl: putOptions.cacheControl ?? null,
      uploadedAt: Date.now(),
      customMetadata,
    };
  }

  async function remove(keys: string | readonly string[]): Promise<void> {
    const list = normalizeDeleteKeys(keys);
    if (list.length === 0) return;
    if (list.length === 1) {
      await within("delete", requestTimeoutMs, (abortSignal) =>
        client.send(new DeleteObjectCommand({ Bucket, Key: list[0] }), { abortSignal }),
      ).catch((error: unknown) => {
        throw unavailable("delete", error);
      });
      return;
    }
    const result = await within("delete", requestTimeoutMs, (abortSignal) =>
      client.send(
        new DeleteObjectsCommand({
          Bucket,
          Delete: { Objects: list.map((Key) => ({ Key })), Quiet: true },
        }),
        { abortSignal },
      ),
    ).catch((error: unknown) => {
      throw unavailable("delete", error);
    });
    const failed = (result.Errors ?? []).filter((error) => error.Code !== "NoSuchKey");
    if (failed.length > 0) {
      throw new Error(
        `Failed to delete ${failed.length} object(s): ${failed
          .slice(0, 3)
          .map((error) => `${error.Key}: ${error.Code}`)
          .join(", ")}`,
      );
    }
  }

  async function list(
    listOptions: { prefix?: string; cursor?: string; limit?: number } = {},
  ): Promise<BlobListPage> {
    const limit = resolveListLimit(listOptions);
    const result = await within("list", requestTimeoutMs, (abortSignal) =>
      client.send(
        new ListObjectsV2Command({
          Bucket,
          MaxKeys: limit,
          ...(listOptions.prefix ? { Prefix: listOptions.prefix } : {}),
          ...(listOptions.cursor ? { StartAfter: listOptions.cursor } : {}),
        }),
        { abortSignal },
      ),
    ).catch((error: unknown) => {
      throw unavailable("list", error);
    });
    const items = (result.Contents ?? []).flatMap((object) =>
      object.Key === undefined
        ? []
        : [
            {
              key: object.Key,
              size: object.Size ?? 0,
              etag: stripQuotes(object.ETag),
              uploadedAt: object.LastModified?.getTime() ?? 0,
            },
          ],
    );
    const last = items.at(-1);
    return { items, cursor: result.IsTruncated && last ? last.key : null };
  }

  return {
    head,
    get,
    put,
    delete: remove,
    list,
    async ping() {
      await within("ping", requestTimeoutMs, (abortSignal) =>
        client.send(new HeadBucketCommand({ Bucket }), { abortSignal }),
      );
    },
    destroy() {
      client.destroy();
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}

/**
 * Options from the same `WEBFLIX_S3_*` variables the API reads (docs/BACKEND.md §4), for tools
 * such as the media uploader: ENDPOINT, REGION (us-east-1), BUCKET (webflix-media),
 * ACCESS_KEY_ID, SECRET_ACCESS_KEY, FORCE_PATH_STYLE (true).
 */
export function s3OptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): S3BlobStoreOptions {
  return {
    endpoint: env.WEBFLIX_S3_ENDPOINT || null,
    region: env.WEBFLIX_S3_REGION || "us-east-1",
    bucket: env.WEBFLIX_S3_BUCKET || "webflix-media",
    accessKeyId: env.WEBFLIX_S3_ACCESS_KEY_ID || null,
    secretAccessKey: env.WEBFLIX_S3_SECRET_ACCESS_KEY || null,
    forcePathStyle: !/^(false|0)$/i.test(env.WEBFLIX_S3_FORCE_PATH_STYLE ?? "true"),
  };
}

/** `createS3BlobStore(s3OptionsFromEnv(env))`. */
export function createS3BlobStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): S3BlobStore {
  return createS3BlobStore(s3OptionsFromEnv(env));
}
