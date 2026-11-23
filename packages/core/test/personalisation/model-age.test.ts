/**
 * An import (or a staff change) made by another process is served everywhere within
 * `MODEL_MAX_AGE_MS`: no copy of the served model is used longer than that after its database
 * read, through the process memo or the shared cache (docs/RECOMMENDATIONS.md, "When a new run
 * is served"). The importer CLI and a Kubernetes Job cannot invalidate other processes' memos;
 * a replica may write a pre-import copy into the shared cache right after the importer deleted
 * it; Workers KV keeps a read at each location for its cacheTtl. The bound holds in each case.
 */
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { writeDemoRecommendations } from "../../src/areas/personalisation/demo-run.ts";
import { importRecommendations } from "../../src/areas/personalisation/importer.ts";
import { MODEL_MAX_AGE_MS } from "../../src/areas/personalisation/serving.ts";
import { TwoLevel } from "../../src/catalog/cache.ts";
import { MemoryKeyValueCache } from "../../src/memory/cache.ts";
import { MemoryBlobStore } from "../../src/memory/index.ts";
import type { KeyValueCache } from "../../src/ports/cache.ts";
import { ManualClock } from "../../src/ports/clock.ts";
import { MemoryLogger } from "../../src/ports/logger.ts";
import {
  createTestServices,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
} from "../../src/testing/index.ts";
import { demoViewer } from "../services/helpers.ts";

const NOW = Date.UTC(2026, 10, 22, 12);

/** One "process": its own memo over `cache` (shared with other processes, or its own). */
function replica(
  cache: KeyValueCache,
  clock: ManualClock,
  database: { version: number },
  options: { maxAgeMs?: number; sharedTtlSec?: number } = {},
) {
  return new TwoLevel(cache, {
    prefix: "test:",
    schema: z.object({ version: z.number() }),
    sharedTtlSec: options.sharedTtlSec ?? 60,
    key: () => "model",
    load: async () => ({ version: database.version }),
    build: (data) => data.version,
    clock,
    logger: new MemoryLogger({ clock }),
    memoryTtlMs: 30_000,
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
  });
}

describe("the served model's age bound", () => {
  it("is 30 seconds", () => {
    expect(MODEL_MAX_AGE_MS).toBe(30_000);
  });

  it("holds with one shared cache, even for a copy written there after the import (Valkey, KV)", async () => {
    const clock = new ManualClock(NOW);
    const shared = new MemoryKeyValueCache({ clock });
    const database = { version: 1 };
    const a = replica(shared, clock, database, { maxAgeMs: MODEL_MAX_AGE_MS });
    const b = replica(shared, clock, database, { maxAgeMs: MODEL_MAX_AGE_MS });

    expect(await a.get()).toBe(1); // read at NOW, written to the shared cache
    clock.advance(1_000);
    database.version = 2; // imported by another process, which could not reach these memos
    clock.advance(19_000);
    // B takes the shared copy (20 s old): its memo ends when the copy turns 30 s, not 30 s on.
    expect(await b.get()).toBe(1);
    clock.set(NOW + MODEL_MAX_AGE_MS - 1);
    expect(await a.get()).toBe(1);
    expect(await b.get()).toBe(1);
    clock.set(NOW + MODEL_MAX_AGE_MS);
    expect(await a.get()).toBe(2);
    expect(await b.get()).toBe(2);
  });

  it("without the bound, the shared cache's own TTL decides (what the importer CLI ran into)", async () => {
    const clock = new ManualClock(NOW);
    const shared = new MemoryKeyValueCache({ clock });
    const database = { version: 1 };
    const a = replica(shared, clock, database, { sharedTtlSec: 120 });
    const b = replica(shared, clock, database, { sharedTtlSec: 120 });
    expect(await a.get()).toBe(1);
    database.version = 2;
    clock.advance(100_000);
    expect(await a.get()).toBe(1);
    expect(await b.get()).toBe(1);
  });

  it("holds when each process has its own cache (dev: the API and the importer CLI)", async () => {
    const clock = new ManualClock(NOW);
    const database = { version: 1 };
    const api = replica(new MemoryKeyValueCache({ clock }), clock, database, {
      maxAgeMs: MODEL_MAX_AGE_MS,
    });
    expect(await api.get()).toBe(1);
    database.version = 2;
    clock.set(NOW + MODEL_MAX_AGE_MS - 1);
    expect(await api.get()).toBe(1);
    clock.set(NOW + MODEL_MAX_AGE_MS);
    expect(await api.get()).toBe(2);
  });

  it("refuses a shared copy stamped far in the future (a skewed clock cannot pin a copy)", async () => {
    const clock = new ManualClock(NOW);
    const shared = new MemoryKeyValueCache({ clock });
    const database = { version: 1 };
    const ahead = new ManualClock(NOW + 3_600_000);
    await replica(shared, ahead, database, { maxAgeMs: MODEL_MAX_AGE_MS }).get();
    database.version = 2;
    expect(await replica(shared, clock, database, { maxAgeMs: MODEL_MAX_AGE_MS }).get()).toBe(2);
  });

  it("serves a run imported by another process within the bound", async () => {
    const t = await createTestServices({ now: NOW });
    const viewer = await demoViewer(t);
    expect((await t.services.browse.getBrowse(viewer, "home", undefined)).policy?.id).toBe("rules");

    // Another process imports (the CLI, a Job): the store changes, this process's caches do not.
    const blobs = new MemoryBlobStore({ clock: t.clock });
    const written = await writeDemoRecommendations({
      blobs,
      catalog: FIXTURE_CATALOG,
      demoAccount: FIXTURE_DEMO_ACCOUNT,
      manifest: FIXTURE_MANIFEST,
      pseudonymKey: t.deps.config.events.pseudonymKey,
      now: t.clock.now(),
      publish: true,
    });
    await importRecommendations({
      blobs,
      store: t.deps.recommendations,
      clock: t.clock,
      logger: t.logger,
    });

    t.clock.set(NOW + MODEL_MAX_AGE_MS - 1);
    expect((await t.services.browse.getBrowse(viewer, "home", undefined)).policy?.id).toBe("rules");
    t.clock.set(NOW + MODEL_MAX_AGE_MS);
    expect((await t.services.browse.getBrowse(viewer, "home", undefined)).policy?.id).toBe(
      `demo:${written.run}`,
    );
  });
});
