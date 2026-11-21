import { sha256Hex } from "../encoding.ts";
import {
  assertBlobKey,
  type BlobBody,
  type BlobListOptions,
  type BlobListPage,
  type BlobMetadata,
  type BlobObject,
  type BlobPutOptions,
  type BlobRange,
  type BlobStore,
  blobBodyToBytes,
  bytesToStream,
  compareBlobKeys,
  contentTypeForKey,
  normalizeDeleteKeys,
  resolveBlobRange,
  resolveListLimit,
} from "../ports/blob-store.ts";
import { type Clock, systemClock } from "../ports/clock.ts";

/** In-process `BlobStore` (tests, sandboxes). Objects are copied in and out. */
export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, { bytes: Uint8Array; meta: BlobMetadata }>();
  private readonly clock: Clock;

  constructor(options: { clock?: Clock } = {}) {
    this.clock = options.clock ?? systemClock;
  }

  async head(key: string): Promise<BlobMetadata | null> {
    assertBlobKey(key);
    const object = this.objects.get(key);
    return object ? structuredClone(object.meta) : null;
  }

  async get(key: string, options: { range?: BlobRange } = {}): Promise<BlobObject | null> {
    assertBlobKey(key);
    const object = this.objects.get(key);
    if (!object) return null;
    const range = options.range ? resolveBlobRange(options.range, object.meta.size) : null;
    const bytes = range
      ? object.bytes.slice(range.offset, range.offset + range.length)
      : object.bytes.slice();
    return { ...structuredClone(object.meta), body: bytesToStream(bytes), range };
  }

  async put(key: string, body: BlobBody, options: BlobPutOptions = {}): Promise<BlobMetadata> {
    assertBlobKey(key);
    const bytes = (await blobBodyToBytes(body)).slice();
    const meta: BlobMetadata = {
      key,
      size: bytes.byteLength,
      etag: (await sha256Hex(bytes)).slice(0, 32),
      contentType: options.contentType ?? contentTypeForKey(key),
      cacheControl: options.cacheControl ?? null,
      uploadedAt: this.clock.now(),
      customMetadata: { ...options.customMetadata },
    };
    this.objects.set(key, { bytes, meta });
    return structuredClone(meta);
  }

  async delete(keys: string | readonly string[]): Promise<void> {
    for (const key of normalizeDeleteKeys(keys)) this.objects.delete(key);
  }

  async list(options: BlobListOptions = {}): Promise<BlobListPage> {
    const limit = resolveListLimit(options);
    const prefix = options.prefix ?? "";
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .filter((key) => options.cursor === undefined || compareBlobKeys(key, options.cursor) > 0)
      .sort(compareBlobKeys);
    const page = keys.slice(0, limit);
    const items = page.flatMap((key) => {
      const meta = this.objects.get(key)?.meta;
      return meta ? [{ key, size: meta.size, etag: meta.etag, uploadedAt: meta.uploadedAt }] : [];
    });
    const last = page[page.length - 1];
    return { items, cursor: keys.length > limit && last !== undefined ? last : null };
  }
}
