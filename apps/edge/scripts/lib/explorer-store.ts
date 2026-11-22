/**
 * The local Worker's R2 bucket as a `BlobStore`, through the dev server's Local Explorer API
 * (`/cdn-cgi/local/explorer/api/r2/buckets/{bucket}/objects…`, served by `wrangler dev`'s own
 * miniflare). Node tooling that must run beside a live dev server uses this instead of
 * `getPlatformProxy`, which would open the same state directory a second time: the explorer is
 * the running runtime answering, so there is still one owner of the state.
 *
 * Local only: on a real account the pipeline reads and writes R2 through its S3 API, and none of
 * this exists. Whole-object reads only (the batch jobs' objects are small); keys are sent as one
 * path segment (`encodeURIComponent`), as the explorer's routes expect.
 */
import type {
  BlobBody,
  BlobListOptions,
  BlobListPage,
  BlobMetadata,
  BlobObject,
  BlobPutOptions,
  BlobStore,
} from "@webflix/core";

interface ExplorerObject {
  key: string;
  etag: string;
  size: number;
  last_modified: string;
  http_metadata?: { contentType?: string; cacheControl?: string };
  custom_metadata?: Record<string, string>;
}

interface ExplorerAnswer<T> {
  success: boolean;
  result: T;
  errors?: { code?: number; message?: string }[];
  result_info?: { cursor?: string; is_truncated?: string | boolean };
}

/** R2's "no such object" in the explorer's answers. */
const NO_SUCH_KEY = 10007;

export interface ExplorerStoreOptions {
  /** The dev server, e.g. `http://localhost:8787`. */
  origin: string;
  bucket: string;
  fetch?: typeof fetch;
}

export function explorerBucketUrl(origin: string, bucket: string): string {
  return `${origin}/cdn-cgi/local/explorer/api/r2/buckets/${encodeURIComponent(bucket)}`;
}

function metadataOf(object: ExplorerObject): BlobMetadata {
  return {
    key: object.key,
    size: object.size,
    etag: object.etag,
    contentType: object.http_metadata?.contentType ?? "application/octet-stream",
    cacheControl: object.http_metadata?.cacheControl ?? null,
    uploadedAt: Date.parse(object.last_modified),
    customMetadata: object.custom_metadata ?? {},
  };
}

async function bytesOf(body: BlobBody): Promise<Uint8Array<ArrayBuffer>> {
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (typeof body === "string") return new Uint8Array(new TextEncoder().encode(body));
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body.stream).arrayBuffer());
}

export function createExplorerBlobStore(options: ExplorerStoreOptions): BlobStore {
  const doFetch = options.fetch ?? fetch;
  const base = explorerBucketUrl(options.origin, options.bucket);
  const objectUrl = (key: string) => `${base}/objects/${encodeURIComponent(key)}`;

  async function answer<T>(response: Response, what: string): Promise<ExplorerAnswer<T>> {
    const body = (await response.json().catch(() => null)) as ExplorerAnswer<T> | null;
    if (!body) throw new Error(`explorer ${what}: ${response.status} without a JSON answer`);
    return body;
  }

  async function head(key: string): Promise<BlobMetadata | null> {
    const response = await doFetch(objectUrl(key), { headers: { "cf-metadata-only": "true" } });
    const body = await answer<ExplorerObject>(response, `head ${key}`);
    if (!body.success) {
      if (body.errors?.some((error) => error.code === NO_SUCH_KEY) || response.status === 404) {
        return null;
      }
      throw new Error(`explorer head ${key}: ${JSON.stringify(body.errors)}`);
    }
    return metadataOf(body.result);
  }

  return {
    head,

    async get(key, getOptions) {
      if (getOptions?.range) throw new Error("explorer store: ranged reads are not supported");
      const response = await doFetch(objectUrl(key));
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        throw new Error(`explorer get ${key}: ${response.status} ${await response.text()}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const object: BlobObject = {
        key,
        size: bytes.byteLength,
        etag: (response.headers.get("ETag") ?? "").replaceAll('"', ""),
        contentType: response.headers.get("Content-Type") ?? "application/octet-stream",
        cacheControl: null,
        uploadedAt: Date.parse(response.headers.get("Last-Modified") ?? "") || 0,
        customMetadata: {},
        body: new Response(bytes).body as ReadableStream<Uint8Array>,
        range: null,
      };
      return object;
    },

    async put(key, body, putOptions?: BlobPutOptions) {
      const bytes = await bytesOf(body);
      const response = await doFetch(objectUrl(key), {
        method: "PUT",
        headers: {
          "Content-Type": putOptions?.contentType ?? "application/octet-stream",
          ...(putOptions?.customMetadata
            ? { "cf-r2-custom-metadata": JSON.stringify(putOptions.customMetadata) }
            : {}),
        },
        body: bytes,
      });
      const result = await answer<{ key: string; etag: string; size: number }>(
        response,
        `put ${key}`,
      );
      if (!result.success) throw new Error(`explorer put ${key}: ${JSON.stringify(result.errors)}`);
      return (
        (await head(key)) ?? {
          key,
          size: bytes.byteLength,
          etag: result.result.etag,
          contentType: putOptions?.contentType ?? "application/octet-stream",
          cacheControl: null,
          uploadedAt: Date.now(),
          customMetadata: putOptions?.customMetadata ?? {},
        }
      );
    },

    async delete(keys) {
      const list = typeof keys === "string" ? [keys] : [...keys];
      for (let start = 0; start < list.length; start += 1000) {
        const batch = list.slice(start, start + 1000);
        if (batch.length === 0) continue;
        const response = await doFetch(`${base}/objects`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch),
        });
        const result = await answer<unknown>(response, "delete");
        if (!result.success) throw new Error(`explorer delete: ${JSON.stringify(result.errors)}`);
      }
    },

    async list(listOptions: BlobListOptions = {}): Promise<BlobListPage> {
      const query = new URLSearchParams({
        per_page: String(Math.min(listOptions.limit ?? 1000, 1000)),
        ...(listOptions.prefix ? { prefix: listOptions.prefix } : {}),
        ...(listOptions.cursor ? { cursor: listOptions.cursor } : {}),
      });
      const response = await doFetch(`${base}/objects?${query}`);
      const result = await answer<ExplorerObject[]>(response, "list");
      if (!result.success) throw new Error(`explorer list: ${JSON.stringify(result.errors)}`);
      const truncated =
        result.result_info?.is_truncated === true || result.result_info?.is_truncated === "true";
      return {
        items: result.result.map((object) => ({
          key: object.key,
          size: object.size,
          etag: object.etag,
          uploadedAt: Date.parse(object.last_modified),
        })),
        cursor: truncated ? (result.result_info?.cursor ?? null) : null,
      };
    },
  };
}
