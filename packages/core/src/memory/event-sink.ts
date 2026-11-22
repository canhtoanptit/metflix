import type { LakeEvent } from "@webflix/contracts";
import { type EventSink, type EventSinkReceipt, partitionLakeEvents } from "../ports/event-sink.ts";
import { createUuidV7Generator, type IdGenerator } from "../ports/ids.ts";

/**
 * In-process `EventSink`: keeps each append's objects (decoded) in memory. Same partitioning
 * and naming as the lake writer, without gzip. Also what the non-production
 * `GET /diagnostics/events` can read back in dev.
 */
export class MemoryEventSink implements EventSink {
  private readonly stored = new Map<string, LakeEvent[]>();
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

  /** Every stored object with its events, in key order. */
  objects(): { key: string; events: LakeEvent[] }[] {
    return [...this.stored.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, events]) => ({ key, events: events.map((event) => structuredClone(event)) }));
  }
}
