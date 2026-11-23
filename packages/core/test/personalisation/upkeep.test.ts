/**
 * Upkeep of the personalisation and experiments areas: experiment reports are kept for the
 * aggregates period only (the privacy page promises 37 months), and an import tells the shared
 * cache of the new model even when its first attempts fail (finding K15), saying so when it
 * never succeeds.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { experimentResultsPruneJob } from "../../src/areas/experiments/service.ts";
import { MemoryBlobStore } from "../../src/memory/index.ts";
import { createTestServices, writeRecsVersion } from "../../src/testing/index.ts";

const DAY = 86_400_000;
/** A turn of the real event loop (Node's `setImmediate`, which the fake clock leaves alone). */
const realTick = (globalThis as unknown as { setImmediate(callback: () => void): void })
  .setImmediate;

describe("experiment report retention", () => {
  it("is scheduled, and deletes reports older than the aggregates period in bounded batches", async () => {
    const t = await createTestServices({ config: { WEBFLIX_AGGREGATES_RETENTION_DAYS: "30" } });
    const now = t.clock.now();
    const repo = t.deps.repos.experiments;
    // 450 reports from before the period (more than one batch), two inside it.
    for (let index = 0; index < 450; index += 1) {
      await repo.saveResults(`exp.${index % 3}`, {
        computedAt: now - 31 * DAY - index,
        report: {},
      });
    }
    await repo.saveResults("exp.0", { computedAt: now - 29 * DAY, report: { kept: true } });
    await repo.saveResults("exp.1", { computedAt: now - DAY, report: { kept: true } });
    const jobs = t.services.experiments.scheduled(now);
    expect(jobs.map((job) => job.type)).toContain(experimentResultsPruneJob.type);
    await t.deps.jobs.publish(experimentResultsPruneJob.create({}));
    await t.queue.drain();
    expect(await repo.pruneResults(now - 30 * DAY, 1_000)).toBe(0);
    expect((await repo.latestResults("exp.0"))?.report).toEqual({ kept: true });
    expect((await repo.latestResults("exp.1"))?.report).toEqual({ kept: true });
    expect(await repo.latestResults("exp.2")).toBeNull();
    expect(
      t.logger.records.find((record) => record.msg === "experiments.results_pruned"),
    ).toMatchObject({ pruned: 450 });
  });
});

describe("telling the shared cache of a new model (K15)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function importWithFailingCache(failures: number) {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    await writeRecsVersion(blobs, {
      run: "20260614-000000-0123abcd",
      asOf: t.clock.now() - DAY,
      expiresAt: t.clock.now() + 2 * DAY,
      neighbours: [],
      profiles: [],
    });
    const realDelete = t.deps.cache.delete.bind(t.deps.cache);
    let failed = 0;
    vi.spyOn(t.deps.cache, "delete").mockImplementation(async (key) => {
      if (key.includes("aged:recs-model") && failed < failures) {
        failed += 1;
        throw new Error("connect ETIMEDOUT");
      }
      return realDelete(key);
    });
    // The waits between attempts on a fake clock; the import's real I/O (digests) on the real
    // event loop in between.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let done = false;
    const pending = t.services.personalisation
      .importRecommendations({ artefacts: blobs })
      .finally(() => {
        done = true;
      });
    while (!done) {
      await vi.advanceTimersByTimeAsync(250);
      await new Promise<void>((resolve) => realTick(resolve));
    }
    return { t, result: await pending, failed };
  }

  it("retries until the shared cache answers", async () => {
    const { t, result, failed } = await importWithFailingCache(2);
    expect(result).toMatchObject({ status: "imported", cacheInvalidated: true });
    expect(failed).toBe(2);
    expect(
      t.logger.records.filter((record) => record.msg === "cache.invalidate_failed"),
    ).toHaveLength(2);
  });

  it("says so when it never does (the command-line importer then exits 3)", async () => {
    const { t, result } = await importWithFailingCache(1_000);
    expect(result).toMatchObject({ status: "imported", cacheInvalidated: false });
    expect(
      t.logger.records.find((record) => record.msg === "recs.cache_invalidation_failed"),
    ).toMatchObject({ attempts: 4 });
  });
});
