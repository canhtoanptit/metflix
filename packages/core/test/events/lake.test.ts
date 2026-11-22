/**
 * The lake writer under failure (at least once, never a silent loss), the lake writer and the
 * memory sink against the EventSink contract, and the pseudonymous keys against the pipeline's
 * own function (services/recs/src/webflix_recs/ids.py `pseudonym`).
 */
import type { LakeEvent } from "@webflix/contracts";
import { makeLakeEvent } from "@webflix/contracts/fixtures";
import { describe, expect, it } from "vitest";
import {
  createBlobLakeEventSink,
  createSubjectKeys,
  createUuidV7Generator,
  DEV_ONLY_PSEUDONYM_KEY,
  decodeLakeObject,
} from "../../src/index.ts";
import { MemoryBlobStore, MemoryEventSink, MemoryJobQueue } from "../../src/memory/index.ts";
import { describeEventSinkContract, readAll } from "../../src/testing/index.ts";
import { clientEvent, createMember, eventServices } from "./helpers.ts";

describeEventSinkContract("memory (events area run)", () => {
  const sink = new MemoryEventSink();
  return { sink, readBack: async () => sink.objects() };
});

async function readLake(blobs: MemoryBlobStore) {
  const { items } = await blobs.list({ prefix: "events/" });
  return Promise.all(
    items.map(async (item) => {
      const object = await blobs.get(item.key);
      if (!object) throw new Error(`${item.key} vanished`);
      return { key: item.key, events: await decodeLakeObject(await readAll(object.body)) };
    }),
  );
}

describeEventSinkContract("lake writer over a memory blob store (events area run)", () => {
  const blobs = new MemoryBlobStore();
  const sink = createBlobLakeEventSink({ blobs, ids: createUuidV7Generator() });
  return { sink, readBack: () => readLake(blobs) };
});

/** A blob store whose `put` fails for the chosen calls (1-based), once each. */
function failingPuts(blobs: MemoryBlobStore, failOn: Set<number>) {
  let calls = 0;
  const put = blobs.put.bind(blobs);
  blobs.put = async (key, body, options) => {
    calls += 1;
    if (failOn.has(calls)) {
      failOn.delete(calls);
      throw new Error(`injected failure on put #${calls} (${key})`);
    }
    return put(key, body, options);
  };
  return blobs;
}

describe("a write that fails half-way through a batch", () => {
  it("rejects with the first partition stored; the retry stores it again; nothing is lost", async () => {
    const blobs = failingPuts(new MemoryBlobStore(), new Set([2]));
    const sink = createBlobLakeEventSink({ blobs, ids: createUuidV7Generator() });
    // One batch across two receipt hours: two objects, the second put fails.
    const batch: LakeEvent[] = [
      makeLakeEvent("impression", { receivedAt: "2026-11-22T10:59:59.000Z" }),
      makeLakeEvent("title.open", { receivedAt: "2026-11-22T11:00:01.000Z" }),
    ];
    await expect(sink.append(batch)).rejects.toThrow(/put #2/);
    expect((await readLake(blobs)).flatMap((object) => object.events)).toEqual([batch[0]]);
    // The consumer's retry appends the whole batch again.
    await sink.append(batch);
    const stored = (await readLake(blobs)).flatMap((object) => object.events) as LakeEvent[];
    expect(stored).toHaveLength(3); // hour 10 twice (at least once), hour 11 once
    const unique = new Map(stored.map((event) => [event.eventId, event]));
    expect([...unique.values()].sort((a, b) => a.eventId.localeCompare(b.eventId))).toEqual(
      [...batch].sort((a, b) => a.eventId.localeCompare(b.eventId)),
    );
  });

  it("through the real consumer: the job retries, then every event is in the lake", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    const blobs = failingPuts(new MemoryBlobStore(), new Set([1]));
    t.deps.eventSink = createBlobLakeEventSink({ blobs, ids: createUuidV7Generator() });
    // Rebuild the services over the failing lake (the sink is read when the job runs).
    const { createServices } = await import("../../src/services/index.ts");
    const services = createServices(t.deps);
    t.queue.setProcessor(services.processor);
    const events = [clientEvent("impression"), clientEvent("impression")];
    await services.events.ingest({ auth: member.as("adult"), events, gpc: false, country: null });
    await t.queue.drain();
    expect(await readLake(blobs)).toEqual([]); // first attempt failed
    expect(t.queue.size).toBe(1); // waiting for its retry
    t.clock.advance(10_000);
    await t.queue.drain();
    const stored = (await readLake(blobs)).flatMap((object) => object.events) as LakeEvent[];
    expect(stored.map((event) => event.eventId)).toEqual(events.map((event) => event.eventId));
  });

  it("after the last attempt, the job and all its events wait in the dead-letter queue", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    const queue = new MemoryJobQueue({ clock: t.clock, maxAttempts: 3 });
    const failing = new MemoryBlobStore();
    failing.put = async () => {
      throw new Error("bucket unavailable");
    };
    const { createServices } = await import("../../src/services/index.ts");
    const services = createServices({
      ...t.deps,
      jobs: queue,
      eventSink: createBlobLakeEventSink({ blobs: failing, ids: createUuidV7Generator() }),
    });
    queue.setProcessor(services.processor);
    const events = [clientEvent("impression"), clientEvent("search.query")];
    await services.events.ingest({ auth: member.as("adult"), events, gpc: false, country: null });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await queue.drain();
      t.clock.advance(3600_000);
    }
    expect(queue.size).toBe(0);
    expect(queue.deadLetters).toHaveLength(1);
    const [dead] = queue.deadLetters;
    expect(dead?.type).toBe("events.append");
    const payload = dead?.payload as { events: LakeEvent[] };
    expect(payload.events.map((event) => event.eventId)).toEqual(
      events.map((event) => event.eventId),
    );
  });
});

describe("pseudonymous subject keys", () => {
  it("match the pipeline's ids.pseudonym for the same key and ids", async () => {
    // Computed with services/recs (`pseudonym(key, kind, id)`, Python hmac + base64url).
    const keys = createSubjectKeys(DEV_ONLY_PSEUDONYM_KEY);
    expect(await keys.account("acc-1")).toBe("npMC-8AxrOLdKIKHf5FEdj");
    expect(await keys.profile("prof-kids")).toBe("LNT3x28nnBatQJkGGVyTAB");
    expect(
      await createSubjectKeys("another-key-of-at-least-thirty-two-chars").account("acc-1"),
    ).not.toBe("npMC-8AxrOLdKIKHf5FEdj");
  });
});

describe("the inline reader's handling of compaction manifests", () => {
  const ACCOUNT = "aK3vB8nQ2wE5rT7yU9iO1p";
  const window = {
    accountKey: ACCOUNT,
    fromMs: Date.parse("2026-11-22T10:00:00.000Z"),
    toMs: Date.parse("2026-11-22T11:00:00.000Z"),
  };
  async function hourWith(manifest: unknown) {
    const blobs = new MemoryBlobStore();
    const sink = createBlobLakeEventSink({ blobs, ids: createUuidV7Generator() });
    const event = makeLakeEvent("impression", { receivedAt: "2026-11-22T10:05:00.000Z" });
    const { objects } = await sink.append([event]);
    if (manifest !== undefined) {
      await blobs.put(
        "events/dt=2026-11-22/hh=10/_compaction.json",
        JSON.stringify({
          format: "webflix.events-compaction",
          ...(manifest as object),
          sources: [{ key: objects[0] }],
        }),
      );
    }
    return { blobs, sink, event, objects };
  }

  it("ignores a version 1 manifest (zstd) and reads the raw objects", async () => {
    const { sink, event } = await hourWith({
      formatVersion: 1,
      parquet: "events/dt=2026-11-22/hh=10/part-1.parquet",
    });
    expect((await sink.accountEvents(window)).events).toEqual([event]);
  });

  it("refuses a manifest of an unknown version rather than guess", async () => {
    const { sink } = await hourWith({ formatVersion: 3 });
    await expect(sink.accountEvents(window)).rejects.toThrow(/unknown version 3/);
  });

  it("reads the hour again when an object disappears meanwhile, and gives up after 3 tries", async () => {
    const { blobs, sink, event, objects } = await hourWith(undefined);
    const get = blobs.get.bind(blobs);
    let vanish = 1;
    blobs.get = async (key, options) => {
      if (key === objects[0] && vanish-- > 0) return null; // a concurrent rewrite, once
      return get(key, options);
    };
    expect((await sink.accountEvents(window)).events).toEqual([event]);
    vanish = 10;
    await expect(sink.accountEvents(window)).rejects.toThrow(/kept changing/);
  });

  it("waits out a rewrite: a manifest naming a file not listed yet", async () => {
    const { sink } = await hourWith({
      formatVersion: 2,
      parquet: "events/dt=2026-11-22/hh=10/part-missing.parquet",
    });
    await expect(sink.accountEvents(window)).rejects.toThrow(/kept changing/);
  });
});
