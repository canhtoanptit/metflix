/**
 * The experiment results importer against results the pipeline's own analysis wrote at smoke
 * size (`make recs PRESET=smoke`: `analyse-experiments`, copied byte for byte from
 * .cache/recs/smoke/store into test/fixtures/experiment-results).
 */
import { describe, expect, it } from "vitest";
import type { StaffAction } from "../../src/index.ts";
import { MemoryBlobStore } from "../../src/memory/index.ts";
import {
  createTestServices,
  experimentDefinition,
  type TestServices,
} from "../../src/testing/index.ts";

const FIXTURES = import.meta.glob<string>("../fixtures/experiment-results/*.fixture", {
  query: "?raw",
  import: "default",
  eager: true,
});
const fixture = (name: string): string => {
  const text = FIXTURES[`../fixtures/experiment-results/${name}.fixture`];
  if (text === undefined) throw new Error(`fixture ${name} missing`);
  return text;
};
const RUN = "20261122-111623-700";
const DIR = `experiments/results/r=${RUN}`;
const staff: StaffAction = {
  actor: { type: "staff", id: "staff-1", name: "Ada" },
  reason: "Pre-registered",
  requestId: null,
};

async function setup(known: string[] = ["recs-aa"]) {
  const t = await createTestServices();
  const blobs = new MemoryBlobStore({ clock: t.clock });
  await blobs.put("experiments/results/current.json", fixture("current.json"));
  await blobs.put(`${DIR}/recs-aa.json`, fixture("recs-aa.json"));
  await blobs.put(`${DIR}/recs-ranking.json`, fixture("recs-ranking.json"));
  for (const key of known) {
    const {
      status: _status,
      salt: _salt,
      registeredAt: _registeredAt,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...design
    } = experimentDefinition({ key });
    await t.services.experiments.createExperiment(design, staff);
  }
  return { t, blobs };
}

const importFrom = (t: TestServices, blobs: MemoryBlobStore) =>
  t.services.experiments.importResults({ artefacts: blobs });

describe("experiment results import", () => {
  it("imports the pipeline's results for the experiments the product knows", async () => {
    const { t, blobs } = await setup();
    expect(await importFrom(t, blobs)).toEqual({
      status: "imported",
      run: RUN,
      imported: ["recs-aa"],
      unchanged: [],
      skipped: [{ key: "recs-ranking", reason: "unknown experiment" }],
    });
    const results = await t.services.experiments.getExperimentResults("recs-aa");
    expect(results.computedAt).toBe("2026-11-22T11:16:23.700Z");
    expect(results.report).toMatchObject({ key: "recs-aa", unit: "profile", control: "control" });
    await expect(t.services.experiments.getExperimentResults("recs-ranking")).rejects.toMatchObject(
      { code: "not_found" },
    );
  });

  it("changes nothing when the same pointer is imported twice", async () => {
    const { t, blobs } = await setup(["recs-aa", "recs-ranking"]);
    expect((await importFrom(t, blobs)).imported).toEqual(["recs-aa", "recs-ranking"]);
    const before = await t.services.experiments.getExperimentResults("recs-ranking");
    const again = await importFrom(t, blobs);
    expect(again).toMatchObject({ imported: [], unchanged: ["recs-aa", "recs-ranking"] });
    expect(await t.services.experiments.getExperimentResults("recs-ranking")).toEqual(before);
  });

  it("refuses a file that does not match the pointer, importing the others", async () => {
    const { t, blobs } = await setup(["recs-aa", "recs-ranking"]);
    await blobs.put(`${DIR}/recs-aa.json`, fixture("recs-aa.json").replace("profile", "PROFILE"));
    const result = await importFrom(t, blobs);
    expect(result.imported).toEqual(["recs-ranking"]);
    expect(result.skipped).toEqual([
      { key: "recs-aa", reason: `${DIR}/recs-aa.json: SHA-256 does not match the pointer` },
    ]);
    expect((await t.services.experiments.getExperimentResults("recs-aa")).report).toBeNull();
  });

  it("never reads a run the pointer does not name, and refuses an unknown major version", async () => {
    const { t, blobs } = await setup();
    const pointer = JSON.parse(fixture("current.json")) as {
      results: { path: string }[];
      formatVersion: number;
    };
    const first = pointer.results[0];
    if (!first) throw new Error("empty pointer");
    first.path = "experiments/results/r=20261101-000000-000/recs-aa.json";
    await blobs.put("experiments/results/current.json", JSON.stringify(pointer));
    expect((await importFrom(t, blobs)).skipped[0]?.reason).toContain("is outside");
    await blobs.put(
      "experiments/results/current.json",
      JSON.stringify({ ...pointer, formatVersion: 2 }),
    );
    await expect(importFrom(t, blobs)).rejects.toThrow(/major version 1/);
  });

  it("answers `none` before anything is published", async () => {
    const t = await createTestServices();
    expect(
      await t.services.experiments.importResults({ artefacts: new MemoryBlobStore() }),
    ).toEqual({
      status: "none",
      run: null,
      imported: [],
      unchanged: [],
      skipped: [],
    });
  });

  it("runs as the scheduler's job, once per published pointer", async () => {
    const { t, blobs } = await setup();
    Object.assign(t.deps, { recommendationArtefacts: blobs });
    await t.services.scheduler.tick();
    await t.queue.drain();
    expect((await t.services.experiments.getExperimentResults("recs-aa")).computedAt).toBe(
      "2026-11-22T11:16:23.700Z",
    );
    // The next tick finds the same pointer and stops before reading any result.
    let reads = 0;
    const get = blobs.get.bind(blobs);
    blobs.get = async (...args) => {
      reads += 1;
      return get(...args);
    };
    await t.services.scheduler.tick();
    await t.queue.drain();
    expect(reads).toBe(0);
  });
});
