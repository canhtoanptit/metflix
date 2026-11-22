/**
 * Hybrid serving end to end through the browse service: learned candidates where they exist,
 * the rule engine where they do not, and every fallback invisible (a full page, no error).
 */
import type { BrowsePage, Row } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import type { Neighbour, ProfileListRow, RecommendationStore } from "../../src/index.ts";
import { MemoryRecommendationStore } from "../../src/memory/index.ts";
import { seededShuffle } from "../../src/recommendations/hash.ts";
import { experimentDefinition } from "../../src/testing/experiments.contract.ts";
import { createTestServices, type TestServices } from "../../src/testing/index.ts";
import { demoViewer } from "../services/helpers.ts";

const DAY = 86_400_000;
const RUN = "20260614-000000-0123abcd";

/** The rule engine against learned candidates, running since before the test clock's now. */
function experiment(salt: string) {
  return experimentDefinition({ salt, startsAt: "2026-01-01T00:00:00.000Z" });
}

type Viewer = Awaited<ReturnType<typeof demoViewer>>;

function rowIds(row: Row | undefined): string[] {
  if (!row) return [];
  return row.items.map((item) => ("title" in item ? item.title.id : item.id));
}

async function allRows(
  t: TestServices,
  viewer: Viewer,
  view: "home" | "series" | "movies" = "home",
) {
  const first = await t.services.browse.getBrowse(viewer, view, undefined);
  const rows = [...first.rows];
  let cursor = first.nextCursor;
  while (cursor) {
    const next = await t.services.browse.getBrowse(viewer, view, cursor);
    rows.push(...next.rows);
    cursor = next.nextCursor;
  }
  return { first, rows };
}

function neighbours(source: string, ids: string[]): Neighbour[] {
  return ids.map((neighbourId, index) => ({
    titleId: source,
    rank: index + 1,
    neighbourId,
    score: 0.9 - index * 0.1,
    support: 20 - index,
  }));
}

/** Publishes a run straight into the store (the importer is tested on its own). */
async function installModel(
  t: TestServices,
  options: {
    store?: RecommendationStore;
    expiresAt?: number;
    generatedAt?: number;
    neighbours?: Neighbour[];
    lists?: Record<string, ProfileListRow[]>;
  } = {},
) {
  const store = options.store ?? t.deps.recommendations;
  const now = t.clock.now();
  const expiresAt = options.expiresAt ?? now + 2 * DAY;
  await store.beginImport({
    run: RUN,
    asOf: now - DAY,
    expiresAt,
    importedAt: now,
    manifestSha256: null,
  });
  await store.putNeighbours(RUN, options.neighbours ?? []);
  const lists = await Promise.all(
    Object.entries(options.lists ?? {}).map(async ([profileId, rows]) => ({
      profileKey: await t.services.personalisation.serving.profileKey(profileId),
      run: RUN,
      generatedAt: options.generatedAt ?? now - DAY,
      expiresAt,
      rows,
    })),
  );
  await store.putProfileLists(RUN, lists);
  await store.activate(RUN, now);
  await t.services.personalisation.serving.invalidate();
}

const DEMO_LISTS: ProfileListRow[] = [
  {
    type: "personal",
    param: null,
    items: [
      ["t-hours", 0.4],
      ["t-tides", 0.35],
      ["t-copper", 0.3], // disliked by the demo profile
      ["t-lowlands", 0.2],
      ["t-unknown", 0.15], // not in the catalog
      ["t-hollow", 0.1],
    ],
  },
  {
    type: "top-picks",
    param: null,
    items: [
      ["t-tides", 0.35],
      ["t-copper", 0.3],
      ["t-orbit", 0.29], // finished since: the rules drop it
      ["t-hours", 0.4],
      ["t-unknown", 0.2],
      ["t-hollow", 0.1],
      ["t-thaw", 0.05],
    ],
  },
  {
    type: "billboard",
    param: null,
    items: [
      ["t-copper", 0.3],
      ["t-thaw", 0.2],
    ],
  },
  {
    type: "because-you-watched",
    param: "t-orbit",
    items: [
      ["t-pebble", 0.8],
      ["t-copper", 0.7],
    ],
  },
];

describe("hybrid serving", () => {
  it("finds a profile's lists under the pipeline's pseudonymous key (vector from webflix_recs.ids)", async () => {
    const t = await createTestServices();
    // pseudonym(b"dev-only-insecure-pseudonym-key-do-not-deploy", "profile", "pr-demo") in Python.
    expect(await t.services.personalisation.serving.profileKey("pr-demo")).toBe(
      "tghcj68lB7cwgNSJX5_DrG",
    );
  });

  it("serves the rule engine, unchanged, while no model is published", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const page = await t.services.browse.getBrowse(viewer, "home", undefined);
    expect(page.policy).toEqual({ id: "rules", explore: false });
    const rules = await t.services.browse.personalize(viewer);
    expect(page.rows.map((row) => row.id)).toEqual(
      rules
        .rows("home")
        .slice(0, 6)
        .map((row) => row.id),
    );
    expect(page.rows.some((row) => row.kind === "top-picks")).toBe(false);
  });

  it("composes the page from learned candidates, under every rule", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    await installModel(t, { lists: { "pr-demo": DEMO_LISTS } });
    const { first, rows } = await allRows(t, viewer);
    expect(first.policy).toEqual({ id: `learned:${RUN}`, explore: false });

    // Top Picks in the model's order, less the disliked, the finished and the unknown title.
    const picks = rows.find((row) => row.kind === "top-picks");
    expect(picks?.title).toBe("Top Picks for Demo");
    expect(rowIds(picks)).toEqual(["t-tides", "t-hours", "t-hollow", "t-thaw"]);
    expect(rows[0]?.kind).toBe("continue-watching");
    expect(rows[1]?.kind).toBe("top-picks");

    // The billboard is the model's first eligible pick (the disliked one is skipped).
    expect(first.billboard?.title.id).toBe("t-thaw");

    // Genre rows follow the learned scores: listed titles first, by score.
    const drama = rows.find((row) => row.id === "home:genre:drama");
    expect(rowIds(drama).slice(0, 3)).toEqual(["t-hours", "t-tides", "t-lowlands"]);
    expect(rowIds(drama)).not.toContain("t-copper");

    // Because You Watched takes the model's row for its source, without the disliked title.
    const because = rows.find((row) => row.id === "home:because-you-watched:t-orbit");
    expect(rowIds(because)[0]).toBe("t-pebble");
    expect(rowIds(because)).not.toContain("t-copper");

    // Rows still never repeat an id and rows still respect the page's other rules.
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it("keeps a row's pages consistent with the page that served it", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    await installModel(t, { lists: { "pr-demo": DEMO_LISTS } });
    const page = await t.services.browse.getBrowse(viewer, "home", undefined);
    const picks = page.rows.find((row) => row.kind === "top-picks");
    const again = await t.services.browse.getRow(viewer, "home:top-picks", undefined, undefined);
    expect(rowIds(again)).toEqual(rowIds(picks));
  });

  it("never gives a restricted profile learned candidates or an experiment", async () => {
    const t = await createTestServices();
    const kids = await demoViewer(t, "pr-kids");
    const before = await allRows(t, kids);
    // Even a list filed under the kids profile (the pipeline never writes one) is not read,
    // and the default policy (learned) does not apply to it.
    await installModel(t, {
      neighbours: neighbours("t-meadow", ["t-copper", "t-owl", "t-pebble", "t-tides"]),
      lists: { "pr-kids": DEMO_LISTS },
    });
    const after = await allRows(t, kids);
    expect(after.first.policy).toEqual({ id: "rules", explore: false });
    expect(after.rows).toEqual(before.rows);
    expect(after.first.billboard).toEqual(before.first.billboard);
    // More Like This too: the model's neighbours of t-meadow (t-copper is 18+) are not used.
    const rules = await t.services.browse.personalize(kids);
    expect(
      (await t.services.browse.listSimilar(kids, "t-meadow")).items.map((card) => card.id),
    ).toEqual(rules.similar("t-meadow", 12));
    // With an experiment running: never assigned, never exposed.
    t.ports.experiments.set([experiment("s1")]);
    expect((await t.services.browse.getBrowse(kids, "home", undefined)).policy?.id).toBe("rules");
    expect(
      await t.services.experiments.assignments(
        { type: "profile", id: "pr-kids" },
        { restricted: true, country: null, plan: "premium", isNew: false },
      ),
    ).toEqual({});
    for (const variant of ["control", "treatment"]) {
      expect(
        await t.deps.cache.get(
          `webflix:v1:exposure:recs.learned-vs-rules:${variant}:profile:pr-kids`,
        ),
      ).toBeNull();
    }
  });

  it("serves a profile the model has no lists for: the learned policy without personal rows", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    await installModel(t, {
      neighbours: neighbours("t-orbit", ["t-pebble", "t-thaw", "t-owl", "t-grin"]),
      lists: { "pr-locked": DEMO_LISTS },
    });
    const { first, rows } = await allRows(t, viewer);
    expect(first.policy?.id).toBe(`learned:${RUN}`);
    expect(rows.some((row) => row.kind === "top-picks")).toBe(false);
    expect(first.billboard).not.toBeNull();
    // Because You Watched Orbit leads with the model's neighbours (t-pebble first).
    const because = rows.find((row) => row.id === "home:because-you-watched:t-orbit");
    expect(rowIds(because).slice(0, 2)).toEqual(["t-pebble", "t-thaw"]);
    for (const row of rows) expect(row.items.length).toBeGreaterThan(0);
  });

  it("gives a title the model has never seen its content neighbours", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const rules = await t.services.browse.listSimilar(viewer, "t-glasshouse");
    await installModel(t, { neighbours: neighbours("t-orbit", ["t-pebble", "t-thaw"]) });
    expect(await t.services.browse.listSimilar(viewer, "t-glasshouse")).toEqual(rules);
    const learned = await t.services.browse.listSimilar(viewer, "t-orbit");
    expect(learned.items.slice(0, 2).map((card) => card.id)).toEqual(["t-pebble", "t-thaw"]);
  });

  it("falls back to the rule engine once the model is stale", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const rules = await allRows(t, viewer);
    await installModel(t, { expiresAt: t.clock.now() + 60_000, lists: { "pr-demo": DEMO_LISTS } });
    expect((await t.services.browse.getBrowse(viewer, "home", undefined)).policy?.id).toBe(
      `learned:${RUN}`,
    );
    t.clock.advance(61_000);
    const stale = await allRows(t, viewer);
    expect(stale.first.policy).toEqual({ id: "rules", explore: false });
    expect(stale.rows.map((row) => row.id)).toEqual(rules.rows.map((row) => row.id));
  });

  it("serves the rule engine when the store is down, without an error", async () => {
    const down = new MemoryRecommendationStore();
    down.servingSnapshot = async () => {
      throw new Error("connection refused");
    };
    const t = await createTestServices();
    Object.assign(t.deps, { recommendations: down });
    const viewer = await demoViewer(t);
    const page = await t.services.browse.getBrowse(viewer, "home", undefined);
    expect(page.policy).toEqual({ id: "rules", explore: false });
    expect(page.rows.length).toBe(6);
    expect(page.billboard).not.toBeNull();
    expect(t.logger.records.some((record) => record.msg === "recs.model_unavailable")).toBe(true);
  });

  it("does not wait for a slow store: the page is the rule engine's", async () => {
    const t = await createTestServices({ config: { WEBFLIX_RECS_READ_TIMEOUT_MS: "20" } });
    const viewer = await demoViewer(t);
    await installModel(t, { lists: { "pr-demo": DEMO_LISTS } });
    const store = t.deps.recommendations;
    let reads = 0;
    const original = store.servingSnapshot.bind(store);
    store.servingSnapshot = async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return original();
    };
    await t.services.personalisation.serving.invalidate();
    const started = performance.now();
    const page = await t.services.browse.getBrowse(viewer, "home", undefined);
    expect(performance.now() - started).toBeLessThan(250);
    expect(page.policy?.id).toBe("rules");
    // The next pages skip the failing store for a while instead of each waiting again.
    await t.services.browse.getBrowse(viewer, "home", undefined);
    expect(reads).toBe(1);
  });

  it("keeps the learned policy when only a profile's lists cannot be read", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    await installModel(t, {
      neighbours: neighbours("t-orbit", ["t-pebble", "t-thaw", "t-owl", "t-grin"]),
      lists: { "pr-demo": DEMO_LISTS },
    });
    t.deps.recommendations.profileLists = async () => {
      throw new Error("lists unavailable");
    };
    const { first, rows } = await allRows(t, viewer);
    expect(first.policy?.id).toBe(`learned:${RUN}`);
    expect(rows.some((row) => row.kind === "top-picks")).toBe(false);
    expect(rowIds(rows.find((row) => row.id === "home:because-you-watched:t-orbit"))[0]).toBe(
      "t-pebble",
    );
  });

  it("re-ranks from what was just watched, without waiting for a batch", async () => {
    // Saltwater was watched a day ago; its learned neighbour t-hollow is unlisted.
    const lists: ProfileListRow[] = [
      {
        type: "personal",
        param: null,
        items: [
          ["t-tides", 0.4],
          ["t-lowlands", 0.3],
        ],
      },
    ];
    const order = async (generatedAt: number) => {
      const t = await createTestServices();
      const viewer = await demoViewer(t);
      await installModel(t, {
        generatedAt: t.clock.now() - generatedAt,
        neighbours: neighbours("t-saltwater", ["t-hollow"]),
        lists: { "pr-demo": lists },
      });
      // The genre page (no cross-row variety moves titles around on it).
      const page = await t.services.browse.getGenrePage(viewer, "drama", {});
      return page.items.map((card) => card.id);
    };
    // Lists made before the watch: the watch boosts t-hollow into the learned tier at once.
    const fresh = await order(2 * DAY);
    expect(fresh.slice(0, 3)).toEqual(["t-tides", "t-lowlands", "t-hollow"]);
    // Lists made after it (they already account for it): no boost.
    const later = await order(0);
    expect(later.indexOf("t-hollow")).toBeGreaterThan(2);
  });

  it("erases a deleted account's lists at once: store, every run, and the caches", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const stranger = "strangerkeystrangerkey";
    await installModel(t, { lists: { "pr-demo": DEMO_LISTS, "pr-locked": DEMO_LISTS } });
    await t.deps.recommendations.putProfileLists(RUN, [
      { profileKey: stranger, run: RUN, generatedAt: 0, expiresAt: t.clock.now() + DAY, rows: [] },
    ]);
    // Served (and so cached) before the deletion.
    expect(
      (await t.services.browse.getBrowse(viewer, "home", undefined)).rows.some(
        (row) => row.kind === "top-picks",
      ),
    ).toBe(true);
    await t.services.personalisation.eraseAccountData("demo-account");
    for (const profileId of ["pr-demo", "pr-locked", "pr-kids"]) {
      const key = await t.services.personalisation.serving.profileKey(profileId);
      expect(await t.deps.recommendations.profileLists(RUN, key, t.clock.now())).toBeNull();
    }
    expect(await t.deps.recommendations.profileLists(RUN, stranger, t.clock.now())).not.toBeNull();
    // Not served from a cache either.
    expect(
      (await t.services.browse.getBrowse(viewer, "home", undefined)).rows.some(
        (row) => row.kind === "top-picks",
      ),
    ).toBe(false);
  });

  describe("exploration", () => {
    async function pages(share: string) {
      const t = await createTestServices({ config: { WEBFLIX_RECS_EXPLORE_SHARE: share } });
      const viewer = await demoViewer(t);
      await installModel(t, { lists: { "pr-demo": DEMO_LISTS } });
      return { t, viewer, page: await allRows(t, viewer) };
    }

    it("randomises rows and items for the slice, says so, and is stable per session", async () => {
      const ordered = await pages("0");
      const explored = await pages("1");
      expect(ordered.page.first.policy).toEqual({ id: `learned:${RUN}`, explore: false });
      expect(explored.page.first.policy).toEqual({ id: `learned:${RUN}`, explore: true });
      const kinds = (page: { rows: Row[] }) => page.rows.map((row) => row.id);
      // Same rows, another order; Continue Watching keeps its place.
      expect([...kinds(explored.page)].sort()).toEqual([...kinds(ordered.page)].sort());
      expect(kinds(explored.page)).not.toEqual(kinds(ordered.page));
      expect(explored.page.rows[0]?.kind).toBe("continue-watching");
      // Canonical lists keep their order: Top 10's ranks, My List.
      for (const kind of ["top-10", "my-list", "continue-watching"]) {
        const a = explored.page.rows.find((row) => row.kind === kind);
        const b = ordered.page.rows.find((row) => row.kind === kind);
        expect(rowIds(a)).toEqual(rowIds(b));
      }
      // Browsing rows are shuffled, deterministically: the same session sees the same page.
      const genre = (page: { rows: Row[] }) =>
        rowIds(page.rows.find((row) => row.id === "home:genre:drama"));
      expect(genre(explored.page)).not.toEqual(genre(ordered.page));
      expect([...genre(explored.page)].sort()).toEqual([...genre(ordered.page)].sort());
      const again = await allRows(explored.t, explored.viewer);
      expect(again.rows).toEqual(explored.page.rows);
      const row = await explored.t.services.browse.getRow(
        explored.viewer,
        "home:genre:drama",
        undefined,
        undefined,
      );
      expect(rowIds(row)).toEqual(genre(explored.page));
    });

    it("shuffles uniformly and deterministically (exploration must not favour a position)", () => {
      const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
      const first = new Map<string, number>();
      let identity = 0;
      for (let index = 0; index < 8000; index += 1) {
        // Session-like seeds that differ only near their end, the hard case for FNV alone.
        const order = seededShuffle(
          items,
          `0190e1c2-0000-7000-8000-${String(index).padStart(12, "0")}:2026-06-15:home:genre:drama`,
        );
        if (order.join() === items.join()) identity += 1;
        first.set(order[0] ?? "", (first.get(order[0] ?? "") ?? 0) + 1);
      }
      // Chi-square, 7 degrees of freedom, against 1000 each: critical 24.32 at p = 0.001.
      const statistic = items.reduce(
        (sum, item) => sum + ((first.get(item) ?? 0) - 1000) ** 2 / 1000,
        0,
      );
      expect(statistic).toBeLessThan(24.32);
      expect(identity).toBeLessThan(5);
      expect(seededShuffle(items, "seed")).toEqual(seededShuffle(items, "seed"));
    });

    it("draws a stable share of sessions", async () => {
      const t = await createTestServices({ config: { WEBFLIX_RECS_EXPLORE_SHARE: "0.05" } });
      const viewer = await demoViewer(t);
      let exploring = 0;
      const sessions = 2000;
      for (let index = 0; index < sessions; index += 1) {
        const plan = await t.services.personalisation.serving.plan({
          ...viewer,
          session: { ...viewer.session, id: `session-${index}` },
        });
        if (plan.policy.explore) exploring += 1;
        if (index < 50) {
          const again = await t.services.personalisation.serving.plan({
            ...viewer,
            session: { ...viewer.session, id: `session-${index}` },
          });
          expect(again.policy.explore).toBe(plan.policy.explore);
        }
      }
      // 5 % of 2000: 100, binomial sd about 9.7.
      expect(exploring).toBeGreaterThan(70);
      expect(exploring).toBeLessThan(130);
    });
  });

  describe("the rule engine against learned candidates experiment", () => {
    async function assigned(variant: "control" | "treatment") {
      const t = await createTestServices();
      const viewer = await demoViewer(t);
      // A salt that puts pr-demo in the wanted arm (assignment is deterministic).
      let salt = 0;
      for (; salt < 64; salt += 1) {
        t.ports.experiments.set([experiment(`s${salt}`)]);
        const got = await t.services.experiments.assignments(
          { type: "profile", id: viewer.profile.id },
          { restricted: false, country: null, plan: "premium", isNew: false },
        );
        if (got["recs.learned-vs-rules"] === variant) break;
      }
      return { t, viewer, salt };
    }

    it("serves the control arm the rule engine and the treatment arm learned candidates", async () => {
      const control = await assigned("control");
      await installModel(control.t, { lists: { "pr-demo": DEMO_LISTS } });
      const a = await control.t.services.browse.getBrowse(control.viewer, "home", undefined);
      expect(a.policy?.id).toBe("rules");
      expect(a.rows.some((row) => row.kind === "top-picks")).toBe(false);

      const treatment = await assigned("treatment");
      await installModel(treatment.t, { lists: { "pr-demo": DEMO_LISTS } });
      const b = await treatment.t.services.browse.getBrowse(treatment.viewer, "home", undefined);
      expect(b.policy?.id).toBe(`learned:${RUN}`);
      expect(b.rows.some((row) => row.kind === "top-picks")).toBe(true);
    });

    it("logs an exposure only when the treatment can apply, once per unit and variant", async () => {
      const { t, viewer } = await assigned("treatment");
      const marker = "webflix:v1:exposure:recs.learned-vs-rules:treatment:profile:pr-demo";
      // No model yet: both arms get the rule engine, so nobody is exposed to a difference.
      await t.services.browse.getBrowse(viewer, "home", undefined);
      expect(await t.deps.cache.get(marker)).toBeNull();
      await installModel(t, { lists: { "pr-demo": DEMO_LISTS } });
      await t.services.browse.getBrowse(viewer, "home", undefined);
      expect(await t.deps.cache.get(marker)).toBe("1");
    });

    it("stops assigning when the experiment stops", async () => {
      const { t, viewer, salt } = await assigned("treatment");
      await installModel(t, { lists: { "pr-demo": DEMO_LISTS } });
      t.ports.experiments.set([{ ...experiment(`s${salt}`), status: "paused" }]);
      // Without an assignment the default policy (learned) applies, with no exposure.
      const page: BrowsePage = await t.services.browse.getBrowse(viewer, "home", undefined);
      expect(page.policy?.id).toBe(`learned:${RUN}`);
      expect(
        await t.services.experiments.assignments(
          { type: "profile", id: viewer.profile.id },
          { restricted: false, country: null, plan: "premium", isNew: false },
        ),
      ).toEqual({});
    });
  });
});
