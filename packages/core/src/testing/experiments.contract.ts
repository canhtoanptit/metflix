import type { ExperimentDefinition } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import type { AssignmentContext, Experiments, ExperimentUnit } from "../ports/experiments.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

export interface ExperimentsHarness extends HarnessBase {
  experiments: Experiments;
  /** Replace the stored definitions (memory: `set`; a database adapter: write the rows). */
  define(definitions: ExperimentDefinition[]): Promise<void>;
}

const NOW = Date.UTC(2026, 10, 22, 12);
const ANYONE: AssignmentContext = {
  plan: "standard",
  country: "US",
  isNew: false,
  restricted: false,
};

/** A running 50/50 profile experiment over the whole of layer `recs`. */
export function experimentDefinition(
  overrides: Partial<ExperimentDefinition> = {},
): ExperimentDefinition {
  return {
    key: "recs.learned-vs-rules",
    name: "Learned recommendations against the rule engine",
    description: null,
    status: "running",
    statusChangeAt: null,
    previousStatus: null,
    unit: "profile",
    layer: "recs",
    allocation: { start: 0, end: 10_000 },
    salt: "s1",
    targeting: { percentage: 100, plans: [], countries: [], audience: "all" },
    variants: [
      { name: "control", weight: 1 },
      { name: "treatment", weight: 1 },
    ],
    control: "control",
    primaryMetric: "qualified_plays",
    secondaryMetrics: [],
    alpha: 0.05,
    power: 0.8,
    minimumDetectableEffect: 0.02,
    startsAt: "2026-11-01T00:00:00.000Z",
    endsAt: null,
    srmThreshold: 0.001,
    registeredAt: "2026-10-30T00:00:00.000Z",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    ...overrides,
  };
}

/** Contract every `Experiments` adapter must pass. */
export function describeExperimentsContract(
  name: string,
  factory: HarnessFactory<ExperimentsHarness>,
): void {
  describe(`Experiments contract: ${name}`, () => {
    const h = useHarness(factory);
    const units = (count: number, type: ExperimentUnit["type"] = "profile"): ExperimentUnit[] =>
      Array.from({ length: count }, (_, index) => ({ type, id: `unit-${index}` }));

    async function shares(key: string, population: ExperimentUnit[], context = ANYONE) {
      const counts = new Map<string, number>();
      for (const unit of population) {
        const variant = (await h().experiments.assign(unit, context, NOW))[key] ?? "(none)";
        counts.set(variant, (counts.get(variant) ?? 0) + 1);
      }
      return counts;
    }

    it("assigns deterministically", async () => {
      await h().define([experimentDefinition()]);
      for (const unit of units(50)) {
        const first = await h().experiments.assign(unit, ANYONE, NOW);
        expect(await h().experiments.assign(unit, ANYONE, NOW)).toEqual(first);
        expect(first["recs.learned-vs-rules"]).toMatch(/^(control|treatment)$/);
      }
    });

    it("splits variants by weight", async () => {
      await h().define([
        experimentDefinition({
          variants: [
            { name: "control", weight: 3 },
            { name: "treatment", weight: 1 },
          ],
        }),
      ]);
      const counts = await shares("recs.learned-vs-rules", units(4000));
      const control = (counts.get("control") ?? 0) / 4000;
      expect(control).toBeGreaterThan(0.71);
      expect(control).toBeLessThan(0.79);
    });

    it("assigns only running experiments within their dates, for the unit's type", async () => {
      await h().define([
        experimentDefinition({ key: "draft", status: "draft" }),
        experimentDefinition({ key: "paused", status: "paused" }),
        experimentDefinition({ key: "later", startsAt: "2026-12-01T00:00:00.000Z" }),
        experimentDefinition({ key: "over", endsAt: "2026-11-20T00:00:00.000Z" }),
        experimentDefinition({ key: "devices", unit: "device", layer: "devices" }),
      ]);
      expect(await h().experiments.assign({ type: "profile", id: "p1" }, ANYONE, NOW)).toEqual({});
      expect(
        Object.keys(await h().experiments.assign({ type: "device", id: "d1" }, ANYONE, NOW)),
      ).toEqual(["devices"]);
    });

    it("follows a scheduled status change only from its instant", async () => {
      const at = new Date(NOW + 60_000).toISOString();
      const unit = { type: "profile" as const, id: "p1" };
      // Starting: still assigned as a draft (nothing) until the change takes effect.
      await h().define([experimentDefinition({ statusChangeAt: at, previousStatus: "draft" })]);
      expect(await h().experiments.assign(unit, ANYONE, NOW)).toEqual({});
      expect(Object.keys(await h().experiments.assign(unit, ANYONE, NOW + 60_000))).toEqual([
        "recs.learned-vs-rules",
      ]);
      // Pausing: still assigned until the change takes effect, then not.
      await h().define([
        experimentDefinition({ status: "paused", statusChangeAt: at, previousStatus: "running" }),
      ]);
      expect(Object.keys(await h().experiments.assign(unit, ANYONE, NOW))).toEqual([
        "recs.learned-vs-rules",
      ]);
      expect(await h().experiments.assign(unit, ANYONE, NOW + 60_000)).toEqual({});
    });

    it("never assigns a restricted profile", async () => {
      await h().define([experimentDefinition()]);
      const restricted = { ...ANYONE, restricted: true };
      for (const unit of units(20)) {
        expect(await h().experiments.assign(unit, restricted, NOW)).toEqual({});
      }
    });

    it("honours targeting: plans, countries, new or existing members, percentage", async () => {
      const targeted = (targeting: Partial<ExperimentDefinition["targeting"]>) =>
        experimentDefinition({
          targeting: { percentage: 100, plans: [], countries: [], audience: "all", ...targeting },
        });
      const unit = { type: "profile" as const, id: "p1" };
      const key = "recs.learned-vs-rules";

      await h().define([targeted({ plans: ["premium"] })]);
      expect((await h().experiments.assign(unit, ANYONE, NOW))[key]).toBeUndefined();
      expect(
        (await h().experiments.assign(unit, { ...ANYONE, plan: "premium" }, NOW))[key],
      ).toBeDefined();

      await h().define([targeted({ countries: ["VN"] })]);
      expect((await h().experiments.assign(unit, ANYONE, NOW))[key]).toBeUndefined();
      expect(
        (await h().experiments.assign(unit, { ...ANYONE, country: "VN" }, NOW))[key],
      ).toBeDefined();

      await h().define([targeted({ audience: "new" })]);
      expect((await h().experiments.assign(unit, ANYONE, NOW))[key]).toBeUndefined();
      expect(
        (await h().experiments.assign(unit, { ...ANYONE, isNew: true }, NOW))[key],
      ).toBeDefined();

      await h().define([targeted({ percentage: 0 })]);
      expect((await shares(key, units(200))).get("(none)")).toBe(200);
      await h().define([targeted({ percentage: 20 })]);
      const enrolled = 2000 - ((await shares(key, units(2000))).get("(none)") ?? 0);
      expect(enrolled / 2000).toBeGreaterThan(0.16);
      expect(enrolled / 2000).toBeLessThan(0.24);
    });

    it("keeps experiments of one layer mutually exclusive by allocation", async () => {
      await h().define([
        experimentDefinition({ key: "a", allocation: { start: 0, end: 5000 } }),
        experimentDefinition({ key: "b", allocation: { start: 5000, end: 10_000 } }),
        experimentDefinition({ key: "other-layer", layer: "billing-ui" }),
      ]);
      let inA = 0;
      for (const unit of units(2000)) {
        const assigned = await h().experiments.assign(unit, ANYONE, NOW);
        expect("a" in assigned && "b" in assigned).toBe(false);
        expect("a" in assigned || "b" in assigned).toBe(true);
        expect(assigned["other-layer"]).toBeDefined();
        if ("a" in assigned) inA += 1;
      }
      expect(inA / 2000).toBeGreaterThan(0.45);
      expect(inA / 2000).toBeLessThan(0.55);
    });

    it("reshuffles every unit when the salt changes", async () => {
      const population = units(1000);
      const key = "recs.learned-vs-rules";
      await h().define([experimentDefinition({ salt: "s1" })]);
      const before = await Promise.all(
        population.map(async (unit) => (await h().experiments.assign(unit, ANYONE, NOW))[key]),
      );
      await h().define([experimentDefinition({ salt: "s2" })]);
      const after = await Promise.all(
        population.map(async (unit) => (await h().experiments.assign(unit, ANYONE, NOW))[key]),
      );
      const same = before.filter((variant, index) => variant === after[index]).length / 1000;
      // Independent 50/50 draws agree about half the time.
      expect(same).toBeGreaterThan(0.4);
      expect(same).toBeLessThan(0.6);
    });

    it("lists every definition it holds", async () => {
      await h().define([
        experimentDefinition(),
        experimentDefinition({ key: "x", status: "draft" }),
      ]);
      expect(
        (await h().experiments.definitions()).map((definition) => definition.key).sort(),
      ).toEqual(["recs.learned-vs-rules", "x"]);
    });
  });
}
