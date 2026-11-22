import {
  type AsyncBuffer,
  type FileMetaData,
  parquetMetadataAsync,
  parquetReadObjects,
} from "hyparquet/src/index.js";
import type { BlobStore } from "./blob-store.ts";
import {
  type AccountEventsOptions,
  type AccountEventsRead,
  decodeLakeObject,
  lakeKeyHour,
  lakeScanPrefixes,
} from "./event-sink.ts";

/**
 * The reader contract of the pipeline's compacted hours (services/recs README, "Compacted
 * hours: the contract for readers"), for one account: list an hour; a version 2 manifest names
 * the current Parquet file (read only the row groups whose `account` statistics admit the key,
 * only the `account` and `raw` columns) and the raw objects it covers (never read); every other
 * raw object is read; a version 1 manifest is ignored; anything that disappears while the hour
 * is read makes it read again (3 attempts). Web-standard only (hyparquet decodes Snappy in JS).
 */

const HOUR_MS = 3_600_000;
const MANIFEST = "_compaction.json";
const ATTEMPTS = 3;

/** An object listed a moment ago is gone: a rewrite is under way; list the hour again. */
class HourChanged extends Error {}

interface StoredEvent {
  eventId?: unknown;
  receivedAt?: unknown;
  subject?: { account?: unknown } | null;
}

async function readBytes(blobs: BlobStore, key: string): Promise<Uint8Array> {
  const object = await blobs.get(key);
  if (!object) throw new HourChanged(key);
  return new Uint8Array(await new Response(object.body).arrayBuffer());
}

/** Ranged reads of a Parquet file through the blob store (the footer, then column chunks). */
async function parquetFile(blobs: BlobStore, key: string): Promise<AsyncBuffer> {
  const head = await blobs.head(key);
  if (!head) throw new HourChanged(key);
  return {
    byteLength: head.size,
    async slice(start: number, end = head.size) {
      const object = await blobs.get(key, { range: { offset: start, length: end - start } });
      if (!object) throw new HourChanged(key);
      return new Response(object.body).arrayBuffer();
    },
  };
}

/** The row groups (and their row ranges) whose `account` min/max admit the key. */
function candidateGroups(metadata: FileMetaData, accountKey: string) {
  const groups: { index: number; rowStart: number; rowEnd: number }[] = [];
  let rowStart = 0;
  metadata.row_groups.forEach((group, index) => {
    const rowEnd = rowStart + Number(group.num_rows);
    const column = group.columns.find((chunk) => chunk.meta_data?.path_in_schema[0] === "account");
    const stats = column?.meta_data?.statistics;
    const min = stats?.min_value;
    const max = stats?.max_value;
    // Byte order equals string order here: the keys are 22 ASCII characters. A group without
    // min/max holds only signed-out events.
    if (
      typeof min === "string" &&
      typeof max === "string" &&
      min <= accountKey &&
      accountKey <= max
    ) {
      groups.push({ index, rowStart, rowEnd });
    }
    rowStart = rowEnd;
  });
  return groups;
}

async function readParquetAccount(
  blobs: BlobStore,
  key: string,
  accountKey: string,
): Promise<{ events: unknown[]; groups: number[] }> {
  const file = await parquetFile(blobs, key);
  const metadata = await parquetMetadataAsync(file);
  const events: unknown[] = [];
  const groups: number[] = [];
  for (const group of candidateGroups(metadata, accountKey)) {
    groups.push(group.index);
    const rows = await parquetReadObjects({
      file,
      metadata,
      columns: ["account", "raw"],
      rowStart: group.rowStart,
      rowEnd: group.rowEnd,
    });
    for (const row of rows) {
      if (row.account === accountKey) events.push(JSON.parse(String(row.raw)) as unknown);
    }
  }
  return { events, groups };
}

interface HourRead {
  events: unknown[];
  objects: string[];
  parquet: { key: string; groups: number[] } | null;
}

async function readHourOnce(
  blobs: BlobStore,
  prefix: string,
  keys: readonly string[],
  accountKey: string,
): Promise<HourRead> {
  let covered = new Set<string>();
  let parquet: string | null = null;
  if (keys.includes(`${prefix}${MANIFEST}`)) {
    const manifest = JSON.parse(
      new TextDecoder().decode(await readBytes(blobs, `${prefix}${MANIFEST}`)),
    ) as { format?: unknown; formatVersion?: unknown; parquet?: unknown; sources?: unknown };
    if (manifest.format !== "webflix.events-compaction") {
      throw new Error(`${prefix}${MANIFEST}: not a compaction manifest`);
    }
    if (manifest.formatVersion === 2) {
      if (typeof manifest.parquet !== "string" || !Array.isArray(manifest.sources)) {
        throw new Error(`${prefix}${MANIFEST}: a version 2 manifest without its file or sources`);
      }
      if (!keys.includes(manifest.parquet)) throw new HourChanged(manifest.parquet);
      parquet = manifest.parquet;
      covered = new Set(
        (manifest.sources as { key?: unknown }[])
          .map((source) => source.key)
          .filter((key): key is string => typeof key === "string"),
      );
    } else if (manifest.formatVersion !== 1) {
      // Never guess: the hour may have no raw objects left.
      throw new Error(`${prefix}${MANIFEST}: unknown version ${String(manifest.formatVersion)}`);
    }
    // Version 1 (zstd, which a Worker cannot decode): the manifest is ignored, every raw
    // object read; the pipeline's next compaction rewrites it as version 2.
  }
  const events: unknown[] = [];
  let groups: number[] = [];
  if (parquet) {
    const read = await readParquetAccount(blobs, parquet, accountKey);
    events.push(...read.events);
    groups = read.groups;
  }
  const objects: string[] = [];
  for (const key of keys) {
    if (!key.endsWith(".ndjson.gz") || covered.has(key)) continue;
    objects.push(key);
    for (const event of await decodeLakeObject(await readBytes(blobs, key))) {
      if ((event as StoredEvent | null)?.subject?.account === accountKey) events.push(event);
    }
  }
  return { events, objects, parquet: parquet ? { key: parquet, groups } : null };
}

async function listAll(blobs: BlobStore, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await blobs.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.items.map((item) => item.key));
    cursor = page.cursor;
  } while (cursor !== null);
  return keys;
}

/** Each `eventId` once (the earliest receipt), ordered by `receivedAt` then `eventId`. */
export function keepEarliestReceipt(events: readonly unknown[]): unknown[] {
  const best = new Map<string, StoredEvent>();
  for (const event of events) {
    const stored = event as StoredEvent;
    if (typeof stored?.eventId !== "string") continue;
    const current = best.get(stored.eventId);
    if (!current || String(stored.receivedAt) < String(current.receivedAt)) {
      best.set(stored.eventId, stored);
    }
  }
  return [...best.values()].sort((a, b) => {
    const ra = String(a.receivedAt);
    const rb = String(b.receivedAt);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return String(a.eventId) < String(b.eventId) ? -1 : 1;
  });
}

/** One account's events from a lake in a blob store, by the readers' contract. */
export async function readAccountEvents(
  blobs: BlobStore,
  options: AccountEventsOptions,
): Promise<AccountEventsRead> {
  const { accountKey, fromMs, toMs } = options;
  const hours = new Map<string, string[]>();
  for (const prefix of lakeScanPrefixes(fromMs, toMs)) {
    for (const key of await listAll(blobs, prefix)) {
      const hour = lakeKeyHour(key);
      if (hour === null || hour + HOUR_MS <= fromMs || hour >= toMs) continue;
      const partition = key.slice(0, key.lastIndexOf("/") + 1);
      const list = hours.get(partition) ?? [];
      list.push(key);
      hours.set(partition, list);
    }
  }
  const events: unknown[] = [];
  const objects: string[] = [];
  const rowGroups: Record<string, number[]> = {};
  for (const [prefix, listed] of [...hours].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let keys = listed;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const hour = await readHourOnce(blobs, prefix, keys, accountKey);
        events.push(...hour.events);
        objects.push(...hour.objects);
        if (hour.parquet) rowGroups[hour.parquet.key] = hour.parquet.groups;
        break;
      } catch (error) {
        if (!(error instanceof HourChanged) || attempt >= ATTEMPTS) {
          throw error instanceof HourChanged
            ? new Error(`${prefix}: kept changing while it was read`)
            : error;
        }
        keys = await listAll(blobs, prefix);
      }
    }
  }
  const inWindow = events.filter((event) => {
    const at = Date.parse(String((event as StoredEvent).receivedAt));
    return at >= fromMs && at < toMs;
  });
  return { events: keepEarliestReceipt(inWindow), read: { objects, rowGroups } };
}
