import type { LakeEvent } from "@webflix/contracts";
import {
  type AccountEventsOptions,
  type AccountEventsRead,
  assertPrivateDocumentKey,
  decodeScanCursor,
  type EventSink,
  type EventSinkReceipt,
  encodeScanCursor,
  isLakeObjectInRange,
  type LakeScanOptions,
  type LakeScanPage,
  partitionLakeEvents,
  privateDocumentKey,
  scanLimit,
} from "../ports/event-sink.ts";
import { createUuidV7Generator, type IdGenerator } from "../ports/ids.ts";
import { keepEarliestReceipt } from "../ports/lake-reader.ts";

/**
 * In-process `EventSink`: keeps each append's objects (decoded) in memory. Same partitioning
 * and naming as the lake writer, without gzip. Also what the non-production
 * `GET /diagnostics/events` can read back in dev.
 */
export class MemoryEventSink implements EventSink {
  private readonly stored = new Map<string, LakeEvent[]>();
  private readonly documents = new Map<string, Uint8Array>();
  private readonly ids: IdGenerator;

  constructor(options: { ids?: IdGenerator } = {}) {
    this.ids = options.ids ?? createUuidV7Generator();
  }

  async append(events: readonly LakeEvent[]): Promise<EventSinkReceipt> {
    const objects: string[] = [];
    for (const [partition, batch] of partitionLakeEvents(events)) {
      const key = `${partition}${this.ids.next()}.ndjson.gz`;
      this.stored.set(
        key,
        batch.map((event) => structuredClone(event)),
      );
      objects.push(key);
    }
    return { objects };
  }

  async scan(options: LakeScanOptions): Promise<LakeScanPage> {
    const limit = scanLimit(options.limit);
    const start = decodeScanCursor(options.cursor).p;
    const keys = [...this.stored.keys()]
      .filter((key) => isLakeObjectInRange(key, options.fromMs, options.toMs))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const page = keys.slice(start, start + limit);
    return {
      objects: page.map((key) => ({
        key,
        events: (this.stored.get(key) ?? []).map((event) => structuredClone(event)),
      })),
      cursor: start + limit < keys.length ? encodeScanCursor({ p: start + limit, c: null }) : null,
    };
  }

  async accountEvents(options: AccountEventsOptions): Promise<AccountEventsRead> {
    const objects: string[] = [];
    const events: unknown[] = [];
    for (const { key, events: stored } of this.objects()) {
      if (!isLakeObjectInRange(key, options.fromMs, options.toMs)) continue;
      objects.push(key);
      for (const event of stored) {
        const at = Date.parse(event.receivedAt);
        if (
          event.subject.account === options.accountKey &&
          at >= options.fromMs &&
          at < options.toMs
        ) {
          events.push(event);
        }
      }
    }
    return { events: keepEarliestReceipt(events), read: { objects, rowGroups: {} } };
  }

  async putDocument(name: string, bytes: Uint8Array): Promise<string> {
    const key = privateDocumentKey(name);
    if (this.documents.has(key)) throw new Error(`Private document ${key} already exists`);
    this.documents.set(key, new Uint8Array(bytes));
    return key;
  }

  async getDocument(key: string): Promise<Uint8Array | null> {
    assertPrivateDocumentKey(key);
    const bytes = this.documents.get(key);
    return bytes ? new Uint8Array(bytes) : null;
  }

  async deleteDocument(key: string): Promise<void> {
    assertPrivateDocumentKey(key);
    this.documents.delete(key);
  }

  /** Every stored object with its events, in key order. */
  objects(): { key: string; events: LakeEvent[] }[] {
    return [...this.stored.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, events]) => ({ key, events: events.map((event) => structuredClone(event)) }));
  }

  /** Every stored event, in key order (a test convenience). */
  events(): LakeEvent[] {
    return this.objects().flatMap((object) => object.events);
  }

  /** Keys of the private documents held (a test convenience). */
  documentKeys(): string[] {
    return [...this.documents.keys()].sort();
  }
}
