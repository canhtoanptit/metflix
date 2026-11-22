import { describe, expect, it } from "vitest";
import {
  MAX_NEIGHBOUR_LOOKUP,
  MAX_NEIGHBOURS_PER_TITLE,
  type Neighbour,
  type ProfileLists,
  type RecommendationModel,
  type RecommendationStore,
} from "../ports/recommendation-store.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

export interface RecommendationStoreHarness extends HarnessBase {
  store: RecommendationStore;
}

const NOW = Date.UTC(2026, 10, 22, 12);
const DAY = 24 * 60 * 60 * 1000;

function model(run: string, asOf = NOW - DAY): RecommendationModel {
  return { run, asOf, expiresAt: asOf + 3 * DAY, importedAt: NOW };
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

    it("serves nothing before the first import", async () => {
      const { store } = h();
      expect(await store.activeModel()).toBeNull();
      expect((await store.neighbours(["t-sintel"])).size).toBe(0);
      expect(await store.profileLists(profileKey(), NOW)).toBeNull();
    });

    it("serves an activated run's neighbours by rank, absent titles left out", async () => {
      const { store } = h();
      await importRun("20261121-000000-aaaaaaaa", ["t-a", "t-b"]);
      await store.activate("20261121-000000-aaaaaaaa");
      expect((await store.activeModel())?.run).toBe("20261121-000000-aaaaaaaa");
      const found = await store.neighbours(["t-a", "t-b", "t-none"]);
      expect([...found.keys()].sort()).toEqual(["t-a", "t-b"]);
      expect(found.get("t-a")?.map((row) => row.rank)).toEqual([1, 2, 3]);
      expect(found.get("t-a")?.[0]).toMatchObject({
        titleId: "t-a",
        neighbourId: "20261121-000000-aaaaaaaa-t-a-1",
      });
    });

    it("keeps a run being imported invisible until it is activated", async () => {
      const { store } = h();
      await importRun("run-a", ["t-a"], 2, "old");
      await store.activate("run-a");
      await importRun("run-b", ["t-a"], 2, "new");
      expect((await store.neighbours(["t-a"])).get("t-a")?.[0]?.neighbourId).toBe("old-t-a-1");
      await store.activate("run-b");
      expect((await store.neighbours(["t-a"])).get("t-a")?.[0]?.neighbourId).toBe("new-t-a-1");
      await store.deleteRun("run-a");
      expect((await store.activeModel())?.run).toBe("run-b");
      expect((await store.neighbours(["t-a"])).get("t-a")).toHaveLength(2);
    });

    it("writes large imports in bounded statements and reads up to the lookup limit", async () => {
      const { store } = h();
      const titles = Array.from({ length: MAX_NEIGHBOUR_LOOKUP + 3 }, (_, index) => `t-${index}`);
      await importRun("run-big", titles, MAX_NEIGHBOURS_PER_TITLE);
      await store.activate("run-big");
      const found = await store.neighbours(titles.slice(0, MAX_NEIGHBOUR_LOOKUP));
      expect(found.size).toBe(MAX_NEIGHBOUR_LOOKUP);
      for (const rows of found.values()) expect(rows).toHaveLength(MAX_NEIGHBOURS_PER_TITLE);
      await expect(store.neighbours(titles)).rejects.toThrow();
    });

    it("imports the same run twice without duplicates", async () => {
      const { store } = h();
      await importRun("run-twice", ["t-a"], 4);
      await importRun("run-twice", ["t-a"], 4);
      await store.activate("run-twice");
      expect((await store.neighbours(["t-a"])).get("t-a")).toHaveLength(4);
    });

    it("refuses neighbour rows a pipeline must never produce", async () => {
      const { store } = h();
      await store.beginImport(model("run-bad"));
      const valid = neighboursOf("t-a", 1)[0] as Neighbour;
      for (const broken of [
        { ...valid, rank: 0 },
        { ...valid, rank: MAX_NEIGHBOURS_PER_TITLE + 1 },
        { ...valid, neighbourId: "t-a" },
        { ...valid, score: 0 },
      ]) {
        await expect(store.putNeighbours("run-bad", [broken])).rejects.toThrow();
      }
    });

    it("returns one profile's lists in one read, last write wins, naming the run", async () => {
      const { store } = h();
      const key = profileKey();
      await store.putProfileLists([lists(key, "run-a")]);
      expect(await store.profileLists(key, NOW)).toEqual(lists(key, "run-a"));
      await store.putProfileLists([lists(key, "run-b")]);
      expect((await store.profileLists(key, NOW))?.run).toBe("run-b");
    });

    it("writes many profiles in bounded statements", async () => {
      const { store } = h();
      const keys = Array.from({ length: 60 }, () => profileKey());
      await store.putProfileLists(keys.map((key) => lists(key, "run-a")));
      for (const key of [keys[0], keys[29], keys[59]]) {
        expect((await store.profileLists(key ?? "", NOW))?.profileKey).toBe(key);
      }
    });

    it("does not serve expired lists (cold start, not an error)", async () => {
      const { store } = h();
      const key = profileKey();
      await store.putProfileLists([lists(key, "run-a", NOW)]);
      expect(await store.profileLists(key, NOW)).toBeNull();
      expect(await store.profileLists(key, NOW - 1)).not.toBeNull();
    });

    it("deletes the lists of profiles absent from a new run", async () => {
      const { store } = h();
      const [kept, gone] = [profileKey(), profileKey()];
      await store.putProfileLists([lists(kept, "run-a"), lists(gone, "run-a")]);
      await store.deleteProfileLists([gone]);
      expect(await store.profileLists(gone, NOW)).toBeNull();
      expect(await store.profileLists(kept, NOW)).not.toBeNull();
    });
  });
}
