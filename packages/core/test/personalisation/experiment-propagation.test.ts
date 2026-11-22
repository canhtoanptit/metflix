/**
 * Finding K4 (docs/KUBERNETES.md §9.11): replicas cache the experiment definitions, so a status
 * change reaches them one by one. Two service instances with their own process caches share one
 * repository and one shared cache here, as two replicas (or two Worker isolates) do: a unit's
 * assignment must be the same on both at every instant, including around the change, and never
 * flip once it is live.
 */
import { describe, expect, it } from "vitest";
import { createRepositoryExperiments } from "../../src/areas/experiments/definitions.ts";
import { createExperimentsService } from "../../src/areas/experiments/service.ts";
import type { AreaSeams } from "../../src/areas/module.ts";
import type { ExperimentUnit, StaffAction } from "../../src/index.ts";
import { createMemoryExperimentsRepository } from "../../src/memory/areas/experiments.ts";
import { MemoryKeyValueCache } from "../../src/memory/index.ts";
import { createTestServices, experimentDefinition } from "../../src/testing/index.ts";

const staff: StaffAction = {
  actor: { type: "staff", id: "staff-1", name: "Ada" },
  reason: "K4",
  requestId: null,
};
const KEY = "recs.learned-vs-rules";
const UNITS: ExperimentUnit[] = Array.from({ length: 100 }, (_, index) => ({
  type: "profile",
  id: `unit-${index}`,
}));
const ANYONE = { plan: "premium" as const, country: null, isNew: false, restricted: false };

async function cluster(propagationSec: number) {
  const t = await createTestServices({
    config: { WEBFLIX_EXPERIMENTS_PROPAGATION_SEC: String(propagationSec) },
  });
  const repository = createMemoryExperimentsRepository();
  const shared = new MemoryKeyValueCache({ clock: t.clock });
  const seams = { emitServerEvent: async () => {} } as unknown as AreaSeams;
  // Two instances: their own definitions cache each, one database and one shared cache.
  const instance = () =>
    createExperimentsService(
      {
        ...t.deps,
        cache: shared,
        repos: { ...t.deps.repos, experiments: repository },
        experiments: createRepositoryExperiments({
          repository,
          clock: t.clock,
          logger: t.logger,
          cache: shared,
        }),
      },
      seams,
    );
  const [a, b] = [instance(), instance()];
  const {
    status: _s,
    salt: _salt,
    registeredAt: _r,
    createdAt: _c,
    updatedAt: _u,
    statusChangeAt: _sc,
    previousStatus: _ps,
    ...design
  } = experimentDefinition({ startsAt: null });
  await a.createExperiment(design, staff);
  const assign = async (service: typeof a) =>
    Promise.all(UNITS.map(async (unit) => (await service.assignments(unit, ANYONE))[KEY] ?? null));
  return { t, a, b, shared, assign };
}

/** Both instances' assignments, second by second, for `seconds` from now. */
async function timeline(
  c: Awaited<ReturnType<typeof cluster>>,
  seconds: number,
  at: Record<number, () => Promise<void>> = {},
) {
  const seen: { at: number; a: (string | null)[]; b: (string | null)[] }[] = [];
  for (let second = 0; second <= seconds; second += 1) {
    await at[second]?.();
    seen.push({ at: second, a: await c.assign(c.a), b: await c.assign(c.b) });
    c.t.clock.advance(1000);
  }
  return seen;
}

describe("experiment status changes across instances (finding K4)", () => {
  it("starts everywhere at one instant, says when, and never flips a unit", async () => {
    const c = await cluster(60);
    // Both instances have read the definitions (the experiment is a draft).
    expect((await c.assign(c.a)).every((variant) => variant === null)).toBe(true);
    expect((await c.assign(c.b)).every((variant) => variant === null)).toBe(true);
    c.t.clock.advance(5000);
    const pressed = c.t.clock.now();
    const started = await c.a.setExperimentStatus(KEY, "running", staff);
    // What staff see: running, live everywhere from statusChangeAt (it starts then too).
    expect(started).toMatchObject({
      status: "running",
      previousStatus: "draft",
      statusChangeAt: new Date(pressed + 60_000).toISOString(),
      startsAt: new Date(pressed + 60_000).toISOString(),
      registeredAt: new Date(pressed).toISOString(),
    });
    // A copy read just before the change keeps turning up in the shared cache after it: a
    // replica's racing write, or Workers KV serving a location's cached read for up to a minute.
    const stale = () =>
      c.shared.set(
        "webflix:v2:experiments",
        JSON.stringify({
          loadedAt: pressed - 1,
          definitions: [
            { ...started, status: "draft", statusChangeAt: null, previousStatus: null },
          ],
        }),
        { ttlSec: 60 },
      );
    const seen = await timeline(c, 75, { 0: stale, 15: stale, 40: stale });
    for (const moment of seen) {
      expect(moment.b, `instances disagree ${moment.at} s after start`).toEqual(moment.a);
      const live = moment.at >= 60;
      expect(moment.a.every((variant) => (live ? variant !== null : variant === null))).toBe(true);
    }
    // Once live, each unit keeps its variant.
    const final = seen.at(-1)?.a;
    for (const moment of seen.filter((entry) => entry.at >= 60)) expect(moment.a).toEqual(final);
    expect(new Set(final)).toEqual(new Set(["control", "treatment"]));
  });

  it("stops everywhere at one instant too, whichever instance staff used", async () => {
    const c = await cluster(60);
    await c.a.setExperimentStatus(KEY, "running", staff);
    c.t.clock.advance(61_000);
    const live = await c.assign(c.a);
    expect(await c.assign(c.b)).toEqual(live);
    const paused = await c.b.setExperimentStatus(KEY, "paused", staff);
    expect(paused).toMatchObject({ status: "paused", previousStatus: "running" });
    for (const moment of await timeline(c, 75)) {
      expect(moment.b, `instances disagree ${moment.at} s after pause`).toEqual(moment.a);
      expect(moment.a).toEqual(moment.at < 60 ? live : UNITS.map(() => null));
    }
  });

  it("without the scheduled instant the instances do disagree (what the test guards against)", async () => {
    const c = await cluster(0);
    await c.assign(c.b); // B caches the draft
    await c.a.setExperimentStatus(KEY, "running", staff);
    const onA = await c.assign(c.a);
    const onB = await c.assign(c.b);
    expect(onA.every((variant) => variant !== null)).toBe(true);
    expect(onB.every((variant) => variant === null)).toBe(true);
  });
});
