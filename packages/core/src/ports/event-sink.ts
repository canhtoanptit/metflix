import { EVENT_LAKE_PREFIX, type LakeEvent } from "@webflix/contracts";
import { utf8Decode, utf8Encode } from "../encoding.ts";
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
 *   consumers deduplicate by `eventId` (the pipeline's compaction does).
 * - An empty batch writes nothing.
 */
export interface EventSink {
  append(events: readonly LakeEvent[]): Promise<EventSinkReceipt>;
}

export interface EventSinkReceipt {
  /** The lake objects written, one per receipt hour of the batch. */
  objects: string[];
}

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

/**
 * The lake writer over a `BlobStore`: one gzip NDJSON object per receipt hour of each batch,
 * under a fresh UUIDv7 name. The events must already be validated and enriched (`LakeEvent`).
 */
export function createBlobLakeEventSink(options: {
  blobs: BlobStore;
  ids: IdGenerator;
}): EventSink {
  return {
    async append(events) {
      const objects: string[] = [];
      for (const [partition, batch] of partitionLakeEvents(events)) {
        const key = `${partition}${options.ids.next()}.ndjson.gz`;
        await options.blobs.put(key, await encodeLakeObject(batch), {
          contentType: "application/gzip",
        });
        objects.push(key);
      }
      return { objects };
    },
  };
}
