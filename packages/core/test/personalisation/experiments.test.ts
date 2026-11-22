/**
 * Experiment assignment and the experiments service: the split is uniform, layers are
 * independent, assignment is stable and identical across runtimes (pinned SHA-256 vectors, also
 * asserted inside workerd), restricted profiles are never assigned, exposures are logged once
 * per unit and variant, and staff changes keep their audit rows and their rules.
 */
import type { ExperimentDefinition } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { createRepositoryExperiments } from "../../src/areas/experiments/definitions.ts";
import { createExperimentsService } from "../../src/areas/experiments/service.ts";
import type { AreaSeams, ServerEventInput } from "../../src/areas/module.ts";
import {
  type AssignmentContext,
  assignVariants,
  hashBucket,
  type StaffAction,
} from "../../src/index.ts";
import { createMemoryExperimentsRepository } from "../../src/memory/areas/experiments.ts";
import { MemoryKeyValueCache } from "../../src/memory/index.ts";
import { describeExperimentsRepositoryContract } from "../../src/testing/areas/experiments.contract.ts";
import { experimentDefinition } from "../../src/testing/experiments.contract.ts";
import { createTestServices, TEST_NOW } from "../../src/testing/index.ts";

const ANYONE: AssignmentContext = {
  plan: "standard",
  country: "US",
  isNew: false,
  restricted: false,
};
const UNITS = Array.from({ length: 20_000 }, (_, index) => ({
  type: "profile" as const,
  id: `0190e1c2-${String(index).padStart(4, "0")}-7000-8000-${String(index * 7919).padStart(12, "0")}`,
}));
/** Chi-square critical values at p = 0.001. */
const CHI2_001 = { 1: 10.83, 9: 27.88 } as const;

function chiSquare(observed: number[], expected: number[]): number {
  return observed.reduce((sum, value, index) => {
    const e = expected[index] ?? 0;
    return sum + (value - e) ** 2 / e;
  }, 0);
}

function running(overrides: Partial<ExperimentDefinition> = {}): ExperimentDefinition {
  return experimentDefinition({ startsAt: "2026-01-01T00:00:00.000Z", ...overrides });
}

describe("assignment", () => {
  it("hashes identically in every runtime (pinned SHA-256 vectors, checked in Python too)", async () => {
    expect(await hashBucket("layer:recs:profile:pr-demo")).toBe(5289);
    expect(await hashBucket("enrol:recs.learned-vs-rules:s1:pr-demo")).toBe(3458);
    expect(await hashBucket("variant:recs.learned-vs-rules:s1:pr-demo")).toBe(9957);
    expect(await hashBucket("layer:billing-ui:device:0190e1c2-0000-7000-8000-000000000001")).toBe(
      1896,
    );
    expect(await hashBucket("")).toBe(8894);
  });

  it("spreads units uniformly over the layer's buckets", async () => {
    const deciles = Array.from({ length: 10 }, () => 0);
    for (const unit of UNITS) {
      const bucket = await hashBucket(`layer:recs:${unit.type}:${unit.id}`);
      deciles[Math.floor(bucket / 1000)] = (deciles[Math.floor(bucket / 1000)] ?? 0) + 1;
    }
    const statistic = chiSquare(
      deciles,
      deciles.map(() => UNITS.length / 10),
    );
    expect(statistic).toBeLessThan(CHI2_001[9]);
  });

  it("splits variants by weight (chi-square against the design)", async () => {
    const definitions = [running()];
    let control = 0;
    for (const unit of UNITS) {
      const variant = (await assignVariants(definitions, unit, ANYONE, TEST_NOW))[
        "recs.learned-vs-rules"
      ];
      if (variant === "control") control += 1;
    }
    const half = UNITS.length / 2;
    expect(chiSquare([control, UNITS.length - control], [half, half])).toBeLessThan(CHI2_001[1]);
  });

  it("keeps layers independent: one layer's arm says nothing about another's", async () => {
    const definitions = [
      running({ key: "recs.learned-vs-rules", layer: "recs" }),
      running({ key: "ui.row-titles", layer: "ui", salt: "u1" }),
    ];
    const table = [
      [0, 0],
      [0, 0],
    ];
    for (const unit of UNITS) {
      const assigned = await assignVariants(definitions, unit, ANYONE, TEST_NOW);
      const a = assigned["recs.learned-vs-rules"] === "treatment" ? 1 : 0;
      const b = assigned["ui.row-titles"] === "treatment" ? 1 : 0;
      const row = table[a] as number[];
      row[b] = (row[b] ?? 0) + 1;
    }
    const total = UNITS.length;
    const rowSum = (index: number) => (table[index]?.[0] ?? 0) + (table[index]?.[1] ?? 0);
    const colSum = (index: number) => (table[0]?.[index] ?? 0) + (table[1]?.[index] ?? 0);
    const observed = [table[0]?.[0], table[0]?.[1], table[1]?.[0], table[1]?.[1]].map(Number);
    const expected = [
      (rowSum(0) * colSum(0)) / total,
      (rowSum(0) * colSum(1)) / total,
      (rowSum(1) * colSum(0)) / total,
      (rowSum(1) * colSum(1)) / total,
    ];
    expect(chiSquare(observed, expected)).toBeLessThan(CHI2_001[1]);
  });

  it("hashes each layer on its own: enrolment in one layer says nothing about another", async () => {
    // Half of each layer's buckets: independent layers put a quarter of the units in both.
    const definitions = [
      running({ key: "recs.learned-vs-rules", layer: "recs", allocation: { start: 0, end: 5000 } }),
      running({
        key: "ui.row-titles",
        layer: "ui",
        salt: "u1",
        allocation: { start: 0, end: 5000 },
      }),
    ];
    const table = [0, 0, 0, 0];
    for (const unit of UNITS) {
      const assigned = await assignVariants(definitions, unit, ANYONE, TEST_NOW);
      const cell =
        ("recs.learned-vs-rules" in assigned ? 2 : 0) + ("ui.row-titles" in assigned ? 1 : 0);
      table[cell] = (table[cell] ?? 0) + 1;
    }
    const [neither = 0, onlyB = 0, onlyA = 0, both = 0] = table;
    const total = UNITS.length;
    const inA = onlyA + both;
    const inB = onlyB + both;
    const expected = [
      ((total - inA) * (total - inB)) / total,
      ((total - inA) * inB) / total,
      (inA * (total - inB)) / total,
      (inA * inB) / total,
    ];
    expect(chiSquare([neither, onlyB, onlyA, both], expected)).toBeLessThan(CHI2_001[1]);
    expect(both / total).toBeGreaterThan(0.23);
    expect(both / total).toBeLessThan(0.27);
  });

  it("keeps each unit's variant across sessions and processes", async () => {
    const definitions = [running()];
    const first = await Promise.all(
      UNITS.slice(0, 200).map((unit) => assignVariants(definitions, unit, ANYONE, TEST_NOW)),
    );
    // A later moment, a fresh copy of the definitions (another process): the same answers.
    const again = await Promise.all(
      UNITS.slice(0, 200).map((unit) =>
        assignVariants(structuredClone(definitions), unit, ANYONE, TEST_NOW + 86_400_000),
      ),
    );
    expect(again).toEqual(first);
  });
});

describeExperimentsRepositoryContract("memory with audit rows", () => {
  const repository = createMemoryExperimentsRepository();
  return {
    repos: { experiments: repository } as never,
    auditRows: async () => [...repository.audit],
  };
});

describe("experiments service", () => {
  const staff: StaffAction = {
    actor: { type: "staff", id: "staff-1", name: "Ada" },
    reason: "Pre-registered for review",
    requestId: "req-1",
  };

  async function setup() {
    const t = await createTestServices();
    const repository = createMemoryExperimentsRepository();
    const emitted: ServerEventInput[] = [];
    const cache = new MemoryKeyValueCache({ clock: t.clock });
    const seams = { emitServerEvent: async (event: ServerEventInput) => void emitted.push(event) };
    const deps = {
      ...t.deps,
      cache,
      repos: { ...t.deps.repos, experiments: repository },
      experiments: createRepositoryExperiments({
        repository,
        clock: t.clock,
        logger: t.logger,
        cache,
      }),
    };
    const service = () => createExperimentsService(deps, seams as unknown as AreaSeams);
    return { t, repository, emitted, service, cache };
  }

  const design = () => {
    const {
      status: _status,
      salt: _salt,
      registeredAt: _registeredAt,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...rest
    } = running();
    return rest;
  };

  it("pre-registers a draft with a generated salt and an audit row, and refuses a taken key", async () => {
    const { service, repository } = await setup();
    const created = await service().createExperiment(design(), staff);
    expect(created).toMatchObject({ status: "draft", registeredAt: null });
    expect(created.salt).toMatch(/^[0-9a-f]{16}$/);
    expect(repository.audit.map((row) => [row.action, row.target.id, row.reason])).toEqual([
      ["experiment.create", "recs.learned-vs-rules", "Pre-registered for review"],
    ]);
    await expect(service().createExperiment(design(), staff)).rejects.toMatchObject({
      code: "experiment_conflict",
    });
    await expect(
      service().createExperiment({ ...design(), key: "bad", control: "nobody" }, staff),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("starts, pauses and completes by the rules; a started design is fixed", async () => {
    const { service } = await setup();
    const unit = { type: "profile" as const, id: "pr-someone" };
    await service().createExperiment(design(), staff);
    expect(await service().assignments(unit, ANYONE)).toEqual({});
    const started = await service().setExperimentStatus("recs.learned-vs-rules", "running", staff);
    expect(started.registeredAt).not.toBeNull();
    expect(Object.keys(await service().assignments(unit, ANYONE))).toEqual([
      "recs.learned-vs-rules",
    ]);
    await expect(
      service().updateExperiment(
        "recs.learned-vs-rules",
        { allocation: { start: 0, end: 10 } },
        staff,
      ),
    ).rejects.toMatchObject({ code: "experiment_conflict" });
    const moved = await service().updateExperiment(
      "recs.learned-vs-rules",
      { endsAt: "2026-12-31T00:00:00.000Z" },
      staff,
    );
    expect(moved.endsAt).toBe("2026-12-31T00:00:00.000Z");
    // Stopping stops assigning at once in this process (others: within the cache's 30 s).
    await service().setExperimentStatus("recs.learned-vs-rules", "paused", staff);
    expect(await service().assignments(unit, ANYONE)).toEqual({});
    await service().setExperimentStatus("recs.learned-vs-rules", "completed", staff);
    await expect(
      service().setExperimentStatus("recs.learned-vs-rules", "running", staff),
    ).rejects.toMatchObject({ code: "experiment_conflict" });
  });

  it("refuses to start an experiment that overlaps a running one in its layer", async () => {
    const { service } = await setup();
    await service().createExperiment({ ...design(), allocation: { start: 0, end: 6000 } }, staff);
    await service().createExperiment(
      { ...design(), key: "recs.other", allocation: { start: 5000, end: 10_000 } },
      staff,
    );
    await service().setExperimentStatus("recs.learned-vs-rules", "running", staff);
    await expect(
      service().setExperimentStatus("recs.other", "running", staff),
    ).rejects.toMatchObject({
      code: "experiment_conflict",
    });
  });

  it("never assigns a restricted profile, lazily or not, and never loads its member facts", async () => {
    const { service } = await setup();
    await service().createExperiment(
      {
        ...design(),
        targeting: { percentage: 100, plans: ["premium"], countries: [], audience: "all" },
      },
      staff,
    );
    await service().setExperimentStatus("recs.learned-vs-rules", "running", staff);
    let loads = 0;
    const lazy = (restricted: boolean) => ({
      restricted,
      country: null,
      member: async () => {
        loads += 1;
        return { plan: "premium" as const, isNew: false };
      },
    });
    expect(await service().assignments({ type: "profile", id: "kid" }, lazy(true))).toEqual({});
    expect(loads).toBe(0);
    expect(
      Object.keys(await service().assignments({ type: "profile", id: "adult" }, lazy(false))),
    ).toEqual(["recs.learned-vs-rules"]);
    expect(loads).toBe(1);
  });

  it("loads member facts only while a running experiment targets them", async () => {
    const { service } = await setup();
    await service().createExperiment(design(), staff);
    await service().setExperimentStatus("recs.learned-vs-rules", "running", staff);
    let loads = 0;
    await service().assignments(
      { type: "profile", id: "adult" },
      {
        restricted: false,
        country: null,
        member: async () => {
          loads += 1;
          return { plan: null, isNew: false };
        },
      },
    );
    expect(loads).toBe(0);
  });

  it("gives GET /session the active profile's assignments, else the device's", async () => {
    const { service, t } = await setup();
    await service().createExperiment(design(), staff);
    await service().createExperiment(
      { ...design(), key: "web.signup-copy", unit: "device", layer: "web" },
      staff,
    );
    await service().setExperimentStatus("recs.learned-vs-rules", "running", staff);
    await service().setExperimentStatus("web.signup-copy", "running", staff);
    const profile = (await t.deps.repos.profiles.list("demo-account")).find(
      (entry) => entry.id === "pr-demo",
    );
    const kids = (await t.deps.repos.profiles.list("demo-account")).find(
      (entry) => entry.id === "pr-kids",
    );
    if (!profile || !kids) throw new Error("fixture profiles missing");
    const base = {
      deviceId: "0190e1c2-0000-7000-8000-000000000001",
      plan: "premium" as const,
      joinedAt: 0,
    };
    expect(Object.keys(await service().sessionAssignments({ ...base, profile }))).toEqual([
      "recs.learned-vs-rules",
    ]);
    expect(Object.keys(await service().sessionAssignments({ ...base, profile: null }))).toEqual([
      "web.signup-copy",
    ]);
    expect(await service().sessionAssignments({ ...base, profile: kids })).toEqual({});
    expect(await service().sessionAssignments({ ...base, profile: null, deviceId: null })).toEqual(
      {},
    );
  });

  it("logs an exposure once per unit and variant, across processes", async () => {
    const { service, emitted } = await setup();
    const exposure = {
      experimentKey: "recs.learned-vs-rules",
      variant: "treatment",
      unit: { type: "profile" as const, id: "pr-demo" },
      accountId: "demo-account",
      profileId: "pr-demo",
    };
    const first = service();
    await first.logExposure(exposure);
    await first.logExposure(exposure);
    // Another process (a fresh service) sees the shared marker.
    await service().logExposure(exposure);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "experiment.exposure",
      payload: {
        experimentKey: "recs.learned-vs-rules",
        variant: "treatment",
        unitType: "profile",
      },
      profileId: "pr-demo",
      context: { experiments: { "recs.learned-vs-rules": "treatment" } },
    });
    await first.logExposure({ ...exposure, variant: "control" });
    expect(emitted).toHaveLength(2);
  });

  it("keeps and serves the analysis job's reports", async () => {
    const { service } = await setup();
    await service().createExperiment(design(), staff);
    expect(await service().getExperimentResults("recs.learned-vs-rules")).toEqual({
      key: "recs.learned-vs-rules",
      computedAt: null,
      report: null,
    });
    await service().saveExperimentResults("recs.learned-vs-rules", { decision: "flat" }, TEST_NOW);
    expect((await service().getExperimentResults("recs.learned-vs-rules")).report).toEqual({
      decision: "flat",
    });
    await expect(service().getExperimentResults("missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
