import { EVENT_LAKE_PREFIX, type LakeEvent } from "@webflix/contracts";
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from "../encoding.ts";
import type { BlobStore } from "./blob-store.ts";
import type { IdGenerator } from "./ids.ts";

/**
 * Port: durable append of validated, enriched event batches to the event lake (milestone 2 §3,
 * §6.2): the canonical store of behaviour data in every mode. A lake writer over the mode's
 * `BlobStore` (filesystem, S3, R2) is the production shape (`createBlobLakeEventSink`).
 *
 * Contract (`describeEventSinkContract`):
 * - Resolves only once the events are stored (a crash after it resolves loses nothing).
 * - Events land in the partition of their `receivedAt` hour (UTC): `events/dt=YYYY-MM-DD/hh=HH/`.
 *   A batch that spans hours is split; an object never mixes hours.
 * - Every append writes new objects (`{uuid}.ndjson.gz`, gzip, one JSON event per line); an
 *   existing object is never overwritten, so concurrent writers cannot lose each other's events.
 * - Delivery is at least once: an append retried after a failure may store events twice;
 *   consumers deduplicate by `eventId` (the pipeline's compaction does). An append that fails
 *   part-way (one partition stored, the next refused) rejects: the caller retries the whole
 *   batch, so the stored part lands twice and nothing is lost.
 * - An empty batch writes nothing.
 * - `scan` reads stored objects back by receipt hour (data export, the diagnostics read-back):
 *   the raw objects only, never the pipeline's compacted Parquet files.
 * - Private documents (data exports, §6.3) live beside the lake under `privacy/`, a prefix that
 *   is never served (`/cdn` serves `public/`, `/media` serves `vod/`).
 */
export interface EventSink {
  append(events: readonly LakeEvent[]): Promise<EventSinkReceipt>;
  /** Stored objects whose receipt hour lies in `[fromMs, toMs)`, in key (time) order, paged. */
  scan(options: LakeScanOptions): Promise<LakeScanPage>;
  /** Store a private document under `privacy/{name}` (never overwrites); returns its key. */
  putDocument(name: string, bytes: Uint8Array): Promise<string>;
  /** A private document's bytes, or null when it does not exist (any more). */
  getDocument(key: string): Promise<Uint8Array | null>;
  /** Idempotent. */
  deleteDocument(key: string): Promise<void>;
}

export interface EventSinkReceipt {
  /** The lake objects written, one per receipt hour of the batch. */
  objects: string[];
}

export interface LakeScanOptions {
  /** Epoch ms; the partition of this instant's hour is the first one read. */
  fromMs: number;
  /** Epoch ms, exclusive: partitions of hours starting at or after it are not read. */
  toMs: number;
  /** Opaque, from the previous page. */
  cursor?: string | null;
  /** Objects listed per page, 1..200 (default 50): bounds the work and memory of one call. */
  limit?: number;
}

export interface LakeScanPage {
  /** Decoded objects (events as stored, unvalidated: readers validate). */
  objects: { key: string; events: unknown[] }[];
  /** Null once the range is exhausted. */
  cursor: string | null;
}

/** Private documents of the privacy jobs: `privacy/…`, never under a served prefix. */
export const PRIVATE_DOCUMENT_PREFIX = "privacy/";
const DOCUMENT_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,3}$/;

export function privateDocumentKey(name: string): string {
  if (!DOCUMENT_NAME.test(name) || name.includes("..")) {
    throw new TypeError(`Invalid private document name ${JSON.stringify(name)}`);
  }
  return `${PRIVATE_DOCUMENT_PREFIX}${name}`;
}

export function assertPrivateDocumentKey(key: string): void {
  if (!key.startsWith(PRIVATE_DOCUMENT_PREFIX)) {
    throw new TypeError(`Not a private document key: ${JSON.stringify(key)}`);
  }
  privateDocumentKey(key.slice(PRIVATE_DOCUMENT_PREFIX.length));
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const LAKE_SCAN_MAX_LIMIT = 200;

/** Start (epoch ms) of the hour partition a lake object key belongs to, or null. */
export function lakeKeyHour(key: string): number | null {
  const match = /^events\/dt=(\d{4}-\d{2}-\d{2})\/hh=(\d{2})\/[^/]+$/.exec(key);
  if (!match) return null;
  const at = Date.parse(`${match[1]}T${match[2]}:00:00.000Z`);
  return Number.isFinite(at) ? at : null;
}

/** True for a raw lake object (`….ndjson.gz`) whose hour lies in `[fromMs, toMs)`. */
export function isLakeObjectInRange(key: string, fromMs: number, toMs: number): boolean {
  if (!key.endsWith(".ndjson.gz")) return false;
  const hour = lakeKeyHour(key);
  return hour !== null && hour + HOUR_MS > fromMs && hour < toMs;
}

/**
 * The prefixes a scan walks: one per UTC day for a window of up to 31 days (so a recent window
 * never lists the whole lake), else the whole lake prefix (keys sort by time either way).
 */
export function lakeScanPrefixes(fromMs: number, toMs: number): string[] {
  if (toMs <= fromMs) return [];
  if (toMs - fromMs > 31 * DAY_MS) return [EVENT_LAKE_PREFIX];
  const prefixes: string[] = [];
  for (let day = fromMs - (fromMs % DAY_MS); day < toMs; day += DAY_MS) {
    prefixes.push(`${EVENT_LAKE_PREFIX}dt=${new Date(day).toISOString().slice(0, 10)}/`);
  }
  return prefixes;
}

interface ScanPosition {
  /** Index into `lakeScanPrefixes(fromMs, toMs)`. */
  p: number;
  /** The blob store's cursor within that prefix. */
  c: string | null;
}

export function encodeScanCursor(position: ScanPosition): string {
  return base64UrlEncode(utf8Encode(JSON.stringify(position)));
}

export function decodeScanCursor(cursor: string | null | undefined): ScanPosition {
  if (!cursor) return { p: 0, c: null };
  try {
    const value = JSON.parse(utf8Decode(base64UrlDecode(cursor))) as Partial<ScanPosition>;
    if (typeof value.p === "number" && Number.isInteger(value.p) && value.p >= 0) {
      return { p: value.p, c: typeof value.c === "string" ? value.c : null };
    }
  } catch {
    // fall through
  }
  throw new TypeError("Invalid lake scan cursor");
}

export function scanLimit(limit: number | undefined): number {
  const value = limit ?? 50;
  if (!Number.isInteger(value) || value < 1 || value > LAKE_SCAN_MAX_LIMIT) {
    throw new RangeError(`limit must be an integer in 1..${LAKE_SCAN_MAX_LIMIT}`);
  }
  return value;
}

// --- Pseudonymous subject keys (services/recs README decision 3) -------------------------------

export type SubjectKind = "account" | "profile";

/**
 * The lake's pseudonymous keys: base64url(HMAC-SHA256(secret, "{kind}:{id}")), first 22
 * characters. The recommendation artefacts are keyed by the profile's, so serving derives it
 * with the same function and the same `WEBFLIX_PSEUDONYM_KEY` (the pipeline's `ids.pseudonym`
 * computes it identically). Holds the imported key, never a pending import (a promise from one
 * Workers request must not be awaited by another).
 */
export function createSubjectKeys(secret: string) {
  let imported: CryptoKey | undefined;
  async function key(): Promise<CryptoKey> {
    if (imported) return imported;
    const fresh = await crypto.subtle.importKey(
      "raw",
      utf8Encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    imported = fresh;
    return fresh;
  }
  async function of(kind: SubjectKind, id: string): Promise<string> {
    const mac = await crypto.subtle.sign("HMAC", await key(), utf8Encode(`${kind}:${id}`));
    return base64UrlEncode(new Uint8Array(mac)).slice(0, 22);
  }
  return {
    of,
    account: (accountId: string) => of("account", accountId),
    profile: (profileId: string) => of("profile", profileId),
  };
}

export type SubjectKeys = ReturnType<typeof createSubjectKeys>;

/** `events/dt=YYYY-MM-DD/hh=HH/` for an instant (the receipt hour, UTC). */
export function lakePartition(receivedAtMs: number): string {
  const iso = new Date(receivedAtMs).toISOString();
  return `${EVENT_LAKE_PREFIX}dt=${iso.slice(0, 10)}/hh=${iso.slice(11, 13)}/`;
}

/** The key of a new lake object in an instant's partition. */
export function lakeObjectKey(receivedAtMs: number, id: string): string {
  return `${lakePartition(receivedAtMs)}${id}.ndjson.gz`;
}

/** Groups a batch by receipt hour (partition), preserving order within each. */
export function partitionLakeEvents(events: readonly LakeEvent[]): Map<string, LakeEvent[]> {
  const partitions = new Map<string, LakeEvent[]>();
  for (const event of events) {
    const receivedAt = Date.parse(event.receivedAt);
    if (!Number.isFinite(receivedAt)) throw new TypeError(`Invalid receivedAt on ${event.eventId}`);
    const partition = lakePartition(receivedAt);
    const list = partitions.get(partition) ?? [];
    list.push(event);
    partitions.set(partition, list);
  }
  return partitions;
}

async function pipeThrough(bytes: Uint8Array, transform: TransformStream<Uint8Array, Uint8Array>) {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A lake object's bytes: gzip of one JSON event per line, newline-terminated (§6.2). */
export async function encodeLakeObject(
  events: readonly LakeEvent[],
): Promise<Uint8Array<ArrayBuffer>> {
  const text = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  return (await pipeThrough(
    utf8Encode(text),
    new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
  )) as Uint8Array<ArrayBuffer>;
}

/** The events of a lake object (blank lines ignored, as the pipeline's reader does). */
export async function decodeLakeObject(bytes: Uint8Array): Promise<unknown[]> {
  const text = utf8Decode(
    await pipeThrough(
      bytes,
      new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
    ),
  );
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

async function readBlob(blobs: BlobStore, key: string): Promise<Uint8Array | null> {
  const object = await blobs.get(key);
  if (!object) return null;
  return new Uint8Array(await new Response(object.body).arrayBuffer());
}

/**
 * The lake writer over a `BlobStore`: one gzip NDJSON object per receipt hour of each batch,
 * under a fresh UUIDv7 name. The events must already be validated and enriched (`LakeEvent`).
 * Partitions are written one after the other: if one is refused, the append rejects with the
 * earlier ones stored, and the caller's retry stores them again (at least once).
 */
export function createBlobLakeEventSink(options: {
  blobs: BlobStore;
  ids: IdGenerator;
}): EventSink {
  const { blobs, ids } = options;
  return {
    async append(events) {
      const objects: string[] = [];
      for (const [partition, batch] of partitionLakeEvents(events)) {
        const key = `${partition}${ids.next()}.ndjson.gz`;
        await blobs.put(key, await encodeLakeObject(batch), { contentType: "application/gzip" });
        objects.push(key);
      }
      return { objects };
    },

    async scan(scan) {
      const limit = scanLimit(scan.limit);
      const prefixes = lakeScanPrefixes(scan.fromMs, scan.toMs);
      let position = decodeScanCursor(scan.cursor);
      // Walk prefixes until one listing page yields a result or the range ends; empty days
      // cost one listing each, never a read. At most 32 listings per call (bounded work).
      for (let listings = 0; position.p < prefixes.length && listings < 32; listings += 1) {
        const prefix = prefixes[position.p] as string;
        const page = await blobs.list({
          prefix,
          limit,
          ...(position.c ? { cursor: position.c } : {}),
        });
        const next: ScanPosition = page.cursor
          ? { p: position.p, c: page.cursor }
          : { p: position.p + 1, c: null };
        const keys = page.items
          .map((item) => item.key)
          .filter((key) => isLakeObjectInRange(key, scan.fromMs, scan.toMs));
        const objects: LakeScanPage["objects"] = [];
        for (const key of keys) {
          const bytes = await readBlob(blobs, key);
          // Removed since it was listed (compaction with --delete-sources): nothing to read.
          if (bytes) objects.push({ key, events: await decodeLakeObject(bytes) });
        }
        const cursor = next.p < prefixes.length ? encodeScanCursor(next) : null;
        if (objects.length > 0 || cursor === null) return { objects, cursor };
        position = next;
      }
      return {
        objects: [],
        cursor: position.p < prefixes.length ? encodeScanCursor(position) : null,
      };
    },

    async putDocument(name, bytes) {
      const key = privateDocumentKey(name);
      if (await blobs.head(key)) throw new Error(`Private document ${key} already exists`);
      await blobs.put(key, new Uint8Array(bytes), {
        contentType: name.endsWith(".gz") ? "application/gzip" : "application/octet-stream",
      });
      return key;
    },

    async getDocument(key) {
      assertPrivateDocumentKey(key);
      return readBlob(blobs, key);
    },

    async deleteDocument(key) {
      assertPrivateDocumentKey(key);
      await blobs.delete(key);
    },
  };
}
