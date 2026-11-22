import { describe, expect, it } from "vitest";
import {
  importRecommendations,
  RecommendationImportError,
  RecommendationImportTooLargeError,
  rollbackRecommendations,
} from "../../src/areas/personalisation/importer.ts";
import { MemoryBlobStore, MemoryRecommendationStore } from "../../src/memory/index.ts";
import { ManualClock } from "../../src/ports/clock.ts";
import { MemoryLogger } from "../../src/ports/logger.ts";
import type {
  Neighbour,
  ProfileLists,
  RecommendationStore,
} from "../../src/ports/recommendation-store.ts";
import { writeRecsVersion } from "../../src/testing/recs-artefacts.ts";

const NOW = Date.UTC(2026, 10, 22, 12);
const DAY = 86_400_000;
const RUN_A = "20261120-000000-aaaaaaaa";
const RUN_B = "20261121-000000-bbbbbbbb";
const RUN_C = "20261122-000000-cccccccc";

function key(index: number): string {
  return `profile${String(index).padStart(15, "0")}`;
}

function neighbours(tag: string, titles = ["t-a", "t-b", "t-c"]): Neighbour[] {
  return titles.flatMap((titleId) =>
    [1, 2].map((rank) => ({
      titleId,
      rank,
      neighbourId: `${tag}-${titleId}-${rank}`,
      score: 1 / (rank + 1),
      support: 10 - rank,
    })),
  );
}

function lists(run: string, profileKey: string, expiresAt = NOW + 2 * DAY): ProfileLists {
  return {
    profileKey,
    run,
    generatedAt: NOW - DAY,
    expiresAt,
    rows: [
      {
        type: "personal",
        param: null,
        items: [
          ["t-a", 0.5],
          ["t-b", 0.25],
        ],
      },
      { type: "top-picks", param: null, items: [["t-b", 0.25]] },
      { type: "future-row-type", param: null, items: [] },
    ],
  };
}

async function setup() {
  const clock = new ManualClock(NOW);
  const blobs = new MemoryBlobStore({ clock });
  const store = new MemoryRecommendationStore();
  const logger = new MemoryLogger({ clock });
  const run = (options: { run?: string; store?: RecommendationStore } = {}) =>
    importRecommendations({
      blobs,
      store: options.store ?? store,
      clock,
      logger,
      ...(options.run ? { run: options.run } : {}),
    });
  return { clock, blobs, store, logger, run };
}

async function publish(
  blobs: MemoryBlobStore,
  run: string,
  options: { profiles?: number; expiresAt?: number; publish?: boolean; shardSize?: number } = {},
) {
  const count = options.profiles ?? 3;
  return writeRecsVersion(blobs, {
    run,
    asOf: NOW - DAY,
    expiresAt: NOW + 2 * DAY,
    neighbours: neighbours(run),
    profiles: Array.from({ length: count }, (_, index) =>
      lists(run, key(index), options.expiresAt),
    ),
    rowGroupSize: 4,
    publish: options.publish ?? true,
    ...(options.shardSize ? { shardSize: options.shardSize } : {}),
  });
}

describe("recommendation importer", () => {
  it("publishes the pointer's run: verified files in, then one activation", async () => {
    const { blobs, store, run } = await setup();
    const written = await publish(blobs, RUN_A, { profiles: 11, shardSize: 5 });
    const result = await run();
    expect(result).toMatchObject({
      status: "imported",
      run: RUN_A,
      previous: null,
      neighbourRows: 6,
      profiles: 11,
      expiredProfiles: 0,
      deleted: [],
    });
    expect(await store.activeModel()).toMatchObject({
      run: RUN_A,
      status: "active",
      asOf: NOW - DAY,
      expiresAt: NOW + 2 * DAY,
      manifestSha256: written.manifestSha256,
    });
    expect((await store.servingSnapshot())?.neighbours).toHaveLength(6);
    // Every shard and every row group (4 rows each) came through, unknown row types kept.
    for (const index of [0, 4, 5, 10]) {
      const found = await store.profileLists(RUN_A, key(index), NOW);
      expect(found?.rows.map((row) => row.type)).toEqual([
        "personal",
        "top-picks",
        "future-row-type",
      ]);
    }
  });

  it("does nothing when the published run is already served", async () => {
    const { blobs, run } = await setup();
    await publish(blobs, RUN_A);
    await run();
    expect(await run()).toMatchObject({ status: "unchanged", run: RUN_A, profiles: 0 });
  });

  it("keeps the previous run for rollback and deletes older ones", async () => {
    const { blobs, store, run, clock } = await setup();
    await publish(blobs, RUN_A);
    await run();
    clock.advance(1000);
    await publish(blobs, RUN_B);
    expect(await run()).toMatchObject({ run: RUN_B, previous: RUN_A, deleted: [] });
    clock.advance(1000);
    await publish(blobs, RUN_C);
    expect(await run()).toMatchObject({ run: RUN_C, previous: RUN_B, deleted: [RUN_A] });
    expect((await store.models()).map((model) => [model.run, model.status])).toEqual([
      [RUN_C, "active"],
      [RUN_B, "ready"],
    ]);

    // Rollback is one write, and the previous run's data is all there.
    expect(await rollbackRecommendations(store, clock.now())).toEqual({ from: RUN_C, to: RUN_B });
    const snapshot = await store.servingSnapshot();
    expect(snapshot?.model.run).toBe(RUN_B);
    expect(snapshot?.neighbours[0]?.neighbourId).toBe(`${RUN_B}-t-a-1`);
    expect((await store.profileLists(RUN_B, key(0), NOW))?.run).toBe(RUN_B);
    // And forward again.
    expect(await rollbackRecommendations(store, clock.now() + 1)).toEqual({
      from: RUN_B,
      to: RUN_C,
    });
  });

  it("has nothing to roll back to before a second run", async () => {
    const { blobs, store, run } = await setup();
    expect(await rollbackRecommendations(store, NOW)).toBeNull();
    await publish(blobs, RUN_A);
    await run();
    expect(await rollbackRecommendations(store, NOW)).toBeNull();
  });

  it("never serves a half-imported run: a failure leaves the previous one active", async () => {
    const { blobs, store, run } = await setup();
    await publish(blobs, RUN_A);
    await run();
    await publish(blobs, RUN_B, { profiles: 1200 });
    let writes = 0;
    const failing: RecommendationStore = {
      ...bind(store),
      async putProfileLists(target, batch) {
        writes += 1;
        if (writes === 2) throw new Error("store went away");
        return store.putProfileLists(target, batch);
      },
    };
    await expect(run({ store: failing })).rejects.toThrow(RecommendationImportError);
    expect((await store.activeModel())?.run).toBe(RUN_A);
    expect((await store.servingSnapshot())?.neighbours[0]?.neighbourId).toBe(`${RUN_A}-t-a-1`);
    expect((await store.models()).find((model) => model.run === RUN_B)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("store went away"),
    });
    // The next attempt imports it completely and removes nothing it should not.
    expect(await run()).toMatchObject({ status: "imported", run: RUN_B, profiles: 1200 });
  });

  it("refuses a file that does not match its manifest, before serving any of it", async () => {
    const { blobs, store, run } = await setup();
    await publish(blobs, RUN_A);
    await run();
    await publish(blobs, RUN_B);
    const shard = `recs/v=${RUN_B}/profiles/part-00000.parquet`;
    const original = new Uint8Array(
      await new Response((await blobs.get(shard))?.body).arrayBuffer(),
    );
    const tampered = original.slice();
    tampered[100] = (tampered[100] ?? 0) ^ 0xff;
    await blobs.put(shard, tampered);
    await expect(run()).rejects.toThrow(/SHA-256 does not match/);
    expect((await store.activeModel())?.run).toBe(RUN_A);
    expect((await store.models()).find((model) => model.run === RUN_B)?.status).toBe("failed");
  });

  it("refuses a manifest whose digest is not the pointer's, registering nothing", async () => {
    const { blobs, store, run } = await setup();
    const written = await publish(blobs, RUN_A);
    const manifest = JSON.parse(
      await new Response((await blobs.get(written.manifestKey))?.body).text(),
    ) as Record<string, unknown>;
    await blobs.put(
      written.manifestKey,
      JSON.stringify({ ...manifest, expiresAt: "2099-01-01T00:00:00.000Z" }),
    );
    await expect(run()).rejects.toThrow(/does not match the pointer/);
    expect(await store.models()).toEqual([]);
  });

  it("refuses an unknown major version and an unpublished store", async () => {
    const { blobs, run } = await setup();
    await expect(run()).rejects.toThrow(/nothing published/);
    const written = await publish(blobs, RUN_A);
    const manifest = JSON.parse(
      await new Response((await blobs.get(written.manifestKey))?.body).text(),
    ) as Record<string, unknown>;
    const bumped = JSON.stringify({ ...manifest, formatVersion: 2 });
    await blobs.put(written.manifestKey, bumped);
    await expect(run({ run: RUN_A })).rejects.toThrow(/format version 2 is not supported/);
  });

  it("refuses up front a run larger than the store can take, says why, writes nothing", async () => {
    const { blobs, store, run } = await setup();
    await publish(blobs, RUN_A);
    await run();
    await publish(blobs, RUN_B, { profiles: 11 });
    let writes = 0;
    const bounded: RecommendationStore = {
      ...bind(store),
      importCapacity: { maxProfileLists: 10, explanation: "use the outside importer" },
      async putNeighbours(target, rows) {
        writes += 1;
        return store.putNeighbours(target, rows);
      },
      async putProfileLists(target, lists) {
        writes += 1;
        return store.putProfileLists(target, lists);
      },
    };
    const refused = await run({ store: bounded }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RecommendationImportTooLargeError);
    expect(refused).toMatchObject({ profileLists: 11, maxProfileLists: 10 });
    expect(String(refused)).toContain("use the outside importer");
    expect(writes).toBe(0);
    expect((await store.activeModel())?.run).toBe(RUN_A);
    expect((await store.models()).find((model) => model.run === RUN_B)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("has 11 profile lists"),
    });
    // At the limit it imports.
    await publish(blobs, RUN_C, { profiles: 10 });
    expect(await run({ store: bounded })).toMatchObject({ status: "imported", profiles: 10 });
  });

  it("imports a scored version that was never published, by run", async () => {
    const { blobs, store, run } = await setup();
    await publish(blobs, RUN_A, { publish: false });
    expect(await run({ run: RUN_A })).toMatchObject({ status: "imported", profiles: 3 });
    expect((await store.activeModel())?.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips lists that have already expired (they would never be served)", async () => {
    const { blobs, store, run } = await setup();
    await publish(blobs, RUN_A, { expiresAt: NOW - 1 });
    expect(await run()).toMatchObject({ profiles: 0, expiredProfiles: 3, neighbourRows: 6 });
    expect((await store.servingSnapshot())?.neighbours).toHaveLength(6);
  });

  it("refuses lists filed under another profile or run", async () => {
    const { blobs, run } = await setup();
    await writeRecsVersion(blobs, {
      run: RUN_A,
      asOf: NOW - DAY,
      expiresAt: NOW + 2 * DAY,
      neighbours: neighbours(RUN_A),
      profiles: [lists(RUN_B, key(1))],
    });
    await expect(run()).rejects.toThrow(/names .* in 20261121-000000-bbbbbbbb/);
  });

  it("refuses neighbour ranks that are not contiguous", async () => {
    const { blobs, run } = await setup();
    await writeRecsVersion(blobs, {
      run: RUN_A,
      asOf: NOW - DAY,
      expiresAt: NOW + 2 * DAY,
      neighbours: [{ titleId: "t-a", rank: 2, neighbourId: "t-b", score: 0.5, support: 1 }],
      profiles: [],
    });
    await expect(run()).rejects.toThrow(/rank 2, expected 1/);
  });
});

/** The store's methods bound to it (to override one in a test). */
function bind(store: RecommendationStore): RecommendationStore {
  return {
    activeModel: () => store.activeModel(),
    models: () => store.models(),
    servingSnapshot: () => store.servingSnapshot(),
    profileLists: (run, profileKey, now) => store.profileLists(run, profileKey, now),
    beginImport: (model) => store.beginImport(model),
    putNeighbours: (run, rows) => store.putNeighbours(run, rows),
    putProfileLists: (run, rows) => store.putProfileLists(run, rows),
    failImport: (run, error) => store.failImport(run, error),
    activate: (run, now) => store.activate(run, now),
    deleteRun: (run) => store.deleteRun(run),
    deleteProfileLists: (keys) => store.deleteProfileLists(keys),
  };
}
