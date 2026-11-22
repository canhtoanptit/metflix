import { describe, expect, it } from "vitest";
import {
  MAX_NEIGHBOURS_PER_TITLE,
  type Neighbour,
  type NewRecommendationModel,
  type ProfileLists,
  type RecommendationStore,
  rollbackTarget,
} from "../ports/recommendation-store.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

export interface RecommendationStoreHarness extends HarnessBase {
  store: RecommendationStore;
}

const NOW = Date.UTC(2026, 10, 22, 12);
const DAY = 24 * 60 * 60 * 1000;

function model(run: string, importedAt = NOW): NewRecommendationModel {
  const asOf = NOW - DAY;
  return { run, asOf, expiresAt: asOf + 3 * DAY, importedAt, manifestSha256: "a".repeat(64) };
}

/** `count` neighbours of `titleId`, ranks 1..count, scores decreasing. */
function neighboursOf(titleId: string, count: number, tag = "n"): Neighbour[] {
  return Array.from({ length: count }, (_, index) => ({
    titleId,
    rank: index + 1,
    neighbourId: `${tag}-${titleId}-${index + 1}`,
    score: 1 - index / (count + 1),
    support: count - index,
  }));
}

function lists(profileKey: string, run: string, expiresAt = NOW + DAY): ProfileLists {
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
          ["t-sintel", 0.41],
          ["t-tears", 0.38],
        ],
      },
      { type: "because-you-watched", param: "t-tears", items: [["t-cosmos", 0.77]] },
    ],
  };
}

/** Contract every `RecommendationStore` adapter must pass. */
export function describeRecommendationStoreContract(
  name: string,
  factory: HarnessFactory<RecommendationStoreHarness>,
): void {
  describe(`RecommendationStore contract: ${name}`, () => {
    const h = useHarness(factory);
    const profileKey = () => crypto.randomUUID().replaceAll("-", "").slice(0, 22);

    async function importRun(run: string, titles: string[], perTitle = 3, tag = run) {
      const { store } = h();
      await store.beginImport(model(run));
      await store.putNeighbours(
        run,
        titles.flatMap((title) => neighboursOf(title, perTitle, tag)),
      );
    }

    it("serves nothing before the first activation", async () => {
      const { store } = h();
      expect(await store.activeModel()).toBeNull();
      expect(await store.servingSnapshot()).toBeNull();
      await importRun("run-a", ["t-a"]);
      expect(await store.activeModel()).toBeNull();
      expect(await store.servingSnapshot()).toBeNull();
      expect((await store.models()).map((entry) => [entry.run, entry.status])).toEqual([
        ["run-a", "importing"],
      ]);
    });

    it("serves the activated run's neighbours in one snapshot, by title then rank", async () => {
      const { store } = h();
      await importRun("20261121-000000-aaaaaaaa", ["t-b", "t-a"]);
      await store.activate("20261121-000000-aaaaaaaa", NOW);
      const active = await store.activeModel();
      expect(active).toMatchObject({
        run: "20261121-000000-aaaaaaaa",
        status: "active",
        activatedAt: NOW,
        finishedAt: NOW,
        asOf: NOW - DAY,
        expiresAt: NOW + 2 * DAY,
        importedAt: NOW,
        manifestSha256: "a".repeat(64),
        error: null,
      });
      const snapshot = await store.servingSnapshot();
      expect(snapshot?.model.run).toBe("20261121-000000-aaaaaaaa");
      expect(snapshot?.neighbours.map((row) => [row.titleId, row.rank])).toEqual([
        ["t-a", 1],
        ["t-a", 2],
        ["t-a", 3],
        ["t-b", 1],
        ["t-b", 2],
        ["t-b", 3],
      ]);
      expect(snapshot?.neighbours[0]).toEqual({
        titleId: "t-a",
        rank: 1,
        neighbourId: "20261121-000000-aaaaaaaa-t-a-1",
        score: 1,
        support: 3,
      });
    });

    it("publishes all at once: a run being imported stays invisible until activated", async () => {
      const { store } = h();
      const key = profileKey();
      await importRun("run-a", ["t-a"], 2, "old");
      await store.putProfileLists("run-a", [lists(key, "run-a")]);
      await store.activate("run-a", NOW);
      await importRun("run-b", ["t-a"], 2, "new");
      await store.putProfileLists("run-b", [lists(key, "run-b")]);
      // Half way through run-b nothing of it is served: readers ask for the active run.
      const before = await store.servingSnapshot();
      expect(before?.model.run).toBe("run-a");
      expect(before?.neighbours[0]?.neighbourId).toBe("old-t-a-1");
      expect((await store.profileLists("run-a", key, NOW))?.run).toBe("run-a");
      await store.activate("run-b", NOW + 1);
      const after = await store.servingSnapshot();
      expect(after?.model.run).toBe("run-b");
      expect(after?.neighbours[0]?.neighbourId).toBe("new-t-a-1");
      expect((await store.profileLists("run-b", key, NOW))?.run).toBe("run-b");
    });

    it("rolls back in one write: the previous run kept its data", async () => {
      const { store } = h();
      const key = profileKey();
      await importRun("run-a", ["t-a"], 2, "old");
      await store.putProfileLists("run-a", [lists(key, "run-a")]);
      await store.activate("run-a", NOW);
      await importRun("run-b", ["t-a"], 2, "new");
      await store.activate("run-b", NOW + 1);
      const models = await store.models();
      expect(models.find((entry) => entry.run === "run-a")?.status).toBe("ready");
      const target = rollbackTarget(models);
      expect(target?.run).toBe("run-a");
      await store.activate("run-a", NOW + 2);
      // The rolled-back run is served again; it finished importing when it was first served.
      expect(await store.activeModel()).toMatchObject({
        run: "run-a",
        activatedAt: NOW + 2,
        finishedAt: NOW,
      });
      expect((await store.servingSnapshot())?.neighbours[0]?.neighbourId).toBe("old-t-a-1");
      expect((await store.profileLists("run-a", key, NOW))?.run).toBe("run-a");
      expect((await store.models()).filter((entry) => entry.status === "active")).toHaveLength(1);
    });

    it("refuses to activate a run that was never begun or that failed", async () => {
      const { store } = h();
      await expect(store.activate("run-missing", NOW)).rejects.toThrow();
      await importRun("run-broken", ["t-a"]);
      await store.failImport("run-broken", "checksum mismatch: profiles/part-00000.parquet");
      await expect(store.activate("run-broken", NOW)).rejects.toThrow();
      expect((await store.models())[0]).toMatchObject({
        run: "run-broken",
        status: "failed",
        error: "checksum mismatch: profiles/part-00000.parquet",
      });
      expect(await store.activeModel()).toBeNull();
    });

    it("deletes retired runs completely, never the active one", async () => {
      const { store } = h();
      await importRun("run-a", ["t-a"], 2, "old");
      await store.activate("run-a", NOW);
      await importRun("run-b", ["t-a"], 2, "new");
      await store.activate("run-b", NOW + 1);
      await expect(store.deleteRun("run-b")).rejects.toThrow();
      await store.deleteRun("run-a");
      expect((await store.models()).map((entry) => entry.run)).toEqual(["run-b"]);
      expect((await store.servingSnapshot())?.neighbours).toHaveLength(2);
      // A deleted run can be imported again from scratch.
      await importRun("run-a", ["t-a"], 1, "again");
      await store.activate("run-a", NOW + 2);
      expect((await store.servingSnapshot())?.neighbours.map((row) => row.neighbourId)).toEqual([
        "again-t-a-1",
      ]);
    });

    it("writes large imports in bounded statements", async () => {
      const { store } = h();
      const titles = Array.from(
        { length: 30 },
        (_, index) => `t-${String(index).padStart(2, "0")}`,
      );
      await importRun("run-big", titles, MAX_NEIGHBOURS_PER_TITLE);
      await store.activate("run-big", NOW);
      const snapshot = await store.servingSnapshot();
      expect(snapshot?.neighbours).toHaveLength(30 * MAX_NEIGHBOURS_PER_TITLE);
      expect(snapshot?.neighbours.at(-1)).toMatchObject({ titleId: "t-29", rank: 40 });
    });

    it("imports the same run twice without duplicates", async () => {
      const { store } = h();
      const key = profileKey();
      await importRun("run-twice", ["t-a"], 4);
      await store.putProfileLists("run-twice", [lists(key, "run-twice")]);
      await importRun("run-twice", ["t-a"], 4);
      await store.putProfileLists("run-twice", [lists(key, "run-twice")]);
      await store.activate("run-twice", NOW);
      expect((await store.servingSnapshot())?.neighbours).toHaveLength(4);
      expect(await store.profileLists("run-twice", key, NOW)).toEqual(lists(key, "run-twice"));
    });

    it("refuses to rewrite the active run in place", async () => {
      const { store } = h();
      await importRun("run-a", ["t-a"]);
      await store.activate("run-a", NOW);
      await expect(store.beginImport(model("run-a"))).rejects.toThrow();
    });

    it("refuses rows a pipeline must never produce", async () => {
      const { store } = h();
      await store.beginImport(model("run-bad"));
      const valid = neighboursOf("t-a", 1)[0] as Neighbour;
      for (const broken of [
        { ...valid, rank: 0 },
        { ...valid, rank: MAX_NEIGHBOURS_PER_TITLE + 1 },
        { ...valid, neighbourId: "t-a" },
        { ...valid, score: 0 },
        { ...valid, support: -1 },
      ]) {
        await expect(store.putNeighbours("run-bad", [broken])).rejects.toThrow();
      }
      await expect(
        store.putProfileLists("run-bad", [lists(profileKey(), "run-other")]),
      ).rejects.toThrow();
      await expect(store.putProfileLists("run-bad", [lists("short", "run-bad")])).rejects.toThrow();
    });

    it("returns one profile's lists of one run in one read", async () => {
      const { store } = h();
      const key = profileKey();
      await store.beginImport(model("run-a"));
      await store.beginImport(model("run-b"));
      await store.putProfileLists("run-a", [lists(key, "run-a")]);
      expect(await store.profileLists("run-a", key, NOW)).toEqual(lists(key, "run-a"));
      expect(await store.profileLists("run-b", key, NOW)).toBeNull();
      expect(await store.profileLists("run-a", profileKey(), NOW)).toBeNull();
    });

    it("writes many profiles in bounded statements", async () => {
      const { store } = h();
      await store.beginImport(model("run-a"));
      const keys = Array.from({ length: 60 }, () => profileKey());
      await store.putProfileLists(
        "run-a",
        keys.map((key) => lists(key, "run-a")),
      );
      for (const key of [keys[0], keys[29], keys[59]]) {
        expect((await store.profileLists("run-a", key ?? "", NOW))?.profileKey).toBe(key);
      }
    });

    it("erases a deleted account's profiles from every run, and only them", async () => {
      const { store } = h();
      const [gone, kept] = [profileKey(), profileKey()];
      for (const run of ["run-a", "run-b"]) {
        await store.beginImport(model(run));
        await store.putProfileLists(run, [lists(gone, run), lists(kept, run)]);
      }
      await store.activate("run-a", NOW);
      await store.deleteProfileLists([gone]);
      for (const run of ["run-a", "run-b"]) {
        expect(await store.profileLists(run, gone, NOW)).toBeNull();
        expect((await store.profileLists(run, kept, NOW))?.profileKey).toBe(kept);
      }
      await store.deleteProfileLists([]);
      await expect(
        store.deleteProfileLists(Array.from({ length: 51 }, () => profileKey())),
      ).rejects.toThrow();
    });

    it("does not serve expired lists (cold start, not an error)", async () => {
      const { store } = h();
      const key = profileKey();
      await store.beginImport(model("run-a"));
      await store.putProfileLists("run-a", [lists(key, "run-a", NOW + 2 * 60_000)]);
      expect(await store.profileLists("run-a", key, NOW + 2 * 60_000)).toBeNull();
      expect(await store.profileLists("run-a", key, NOW)).not.toBeNull();
    });
  });
}
