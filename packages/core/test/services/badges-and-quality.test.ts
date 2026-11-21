import {
  type BrowsePage,
  type BrowseView,
  type Row,
  type TitleCard,
  TOP_10_BADGES_PER_LIST,
} from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import {
  createTestServices,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
  type TestServices,
} from "../../src/testing/index.ts";
import { demoViewer } from "./helpers.ts";

function cardsOf(row: Row): TitleCard[] {
  switch (row.layout) {
    case "ranked":
    case "continue":
      return row.items.map((item) => item.title);
    default:
      return row.items;
  }
}

async function wholePage(t: TestServices, view: BrowseView): Promise<BrowsePage> {
  const viewer = await demoViewer(t);
  const first = await t.services.browse.getBrowse(viewer, view, undefined);
  const rows = [...first.rows];
  let cursor = first.nextCursor;
  while (cursor) {
    const next = await t.services.browse.getBrowse(viewer, view, cursor);
    rows.push(...next.rows);
    cursor = next.nextCursor;
  }
  return { ...first, rows, nextCursor: null };
}

/** The ids of the "Top 10 ... Today" list(s) a view shows, by title type. */
function top10Lists(page: BrowsePage): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const row of page.rows) {
    if (row.layout !== "ranked") continue;
    for (const item of row.items) ranks.set(item.title.id, item.rank);
  }
  return ranks;
}

describe("badges", () => {
  for (const view of ["home", "series", "movies", "new-popular"] as const) {
    it(`agree with the Top 10 row of ${view} and stay rare`, async () => {
      const t = await createTestServices();
      const page = await wholePage(t, view);
      const ranks = top10Lists(page);
      expect(ranks.size).toBeGreaterThan(0);
      for (const row of page.rows) {
        const cards = cardsOf(row);
        const top10 = cards.filter((card) => card.badge === "top-10");
        if (row.layout === "continue" || row.layout === "ranked") {
          expect(top10, `${row.id} carries Top 10 badges`).toEqual([]);
        } else {
          expect(top10.length, `${row.id} Top 10 badges`).toBeLessThanOrEqual(
            TOP_10_BADGES_PER_LIST,
          );
          // The badge goes to the first ranked cards of the row, in row order.
          const ranked = cards.filter(
            (card) => card.top10Rank !== undefined && card.badge !== "new-episodes",
          );
          expect(top10.map((card) => card.id)).toEqual(
            ranked.slice(0, TOP_10_BADGES_PER_LIST).map((card) => card.id),
          );
        }
        for (const card of cards) {
          // Every rank a card states is the rank the view's Top 10 row shows.
          expect(card.top10Rank, `${row.id} ${card.id}`).toBe(ranks.get(card.id));
          if (card.badge === "top-10") expect(ranks.has(card.id)).toBe(true);
        }
      }
    });
  }

  it("never shows a Top 10 badge in Continue Watching, even for a chart-topper", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const list = await t.services.library.continueWatching(viewer);
    const home = await wholePage(t, "home");
    const ranked = list.items.filter((item) => item.title.top10Rank !== undefined);
    expect(ranked.length).toBeGreaterThan(0);
    expect(list.items.every((item) => item.title.badge !== "top-10")).toBe(true);
    expect(
      ranked.every((item) => top10Lists(home).get(item.title.id) === item.title.top10Rank),
    ).toBe(true);
  });

  it("states the rank on detail and the billboard, where there is room for it", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const home = await wholePage(t, "home");
    const [first] = [...top10Lists(home)].sort((a, b) => a[1] - b[1]);
    if (!first) throw new Error("no Top 10");
    const detail = await t.services.browse.getTitle(viewer, first[0]);
    expect(detail.top10Rank).toBe(1);
    expect(["top-10", "new-episodes"]).toContain(detail.badge);
    const billboard = home.billboard?.title;
    if (billboard?.top10Rank !== undefined) expect(billboard.badge).not.toBeNull();
  });

  it("puts New Episodes before Top 10, and Top 10 before New", async () => {
    // Kestrel Bay (two seasons, the most popular series) arrives this week.
    const t = await createTestServices({
      seed: {
        catalog: {
          ...FIXTURE_CATALOG,
          titles: FIXTURE_CATALOG.titles.map((title) =>
            title.id === "t-kestrel" || title.id === "t-meadow"
              ? { ...title, addedDaysAgo: 3 }
              : title,
          ),
        },
        demoAccount: FIXTURE_DEMO_ACCOUNT,
        manifest: FIXTURE_MANIFEST,
      },
    });
    const viewer = await demoViewer(t);
    const kestrel = await t.services.browse.getTitle(viewer, "t-kestrel");
    expect(kestrel.top10Rank).toBeDefined();
    expect(kestrel.badge).toBe("new-episodes");
    // One season, recently added: "new" unless it is ranked.
    const meadow = await t.services.browse.getTitle(viewer, "t-meadow");
    expect(meadow.badge).toBe(meadow.top10Rank === undefined ? "new" : "top-10");
  });
});

describe("video quality", () => {
  it("states the best packaged quality on cards, detail and playback; nothing for external media", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    // The packaged fixture asset tops out at 1920×1080.
    expect((await t.services.browse.getTitle(viewer, "t-orbit")).bestVideoQuality).toBe("full-hd");
    expect((await t.services.browse.getTitle(viewer, "t-kestrel")).bestVideoQuality).toBe(
      "full-hd",
    );
    const external = await t.services.browse.getTitle(viewer, "t-harvest");
    expect(external).not.toHaveProperty("bestVideoQuality");
    const home = await wholePage(t, "home");
    const orbit = home.rows.flatMap(cardsOf).find((card) => card.id === "t-orbit");
    expect(orbit?.bestVideoQuality).toBe("full-hd");

    const session = await t.services.playback.start(viewer, { titleId: "t-orbit" });
    expect(session.bestVideoQuality).toBe("full-hd");
    const fallback = await t.services.playback.start(viewer, { titleId: "t-harvest" });
    expect(fallback).not.toHaveProperty("bestVideoQuality");
  });

  it("names wide-screen encodes after the frame they fill", async () => {
    const scope = (width: number, height: number) =>
      createTestServices({
        seed: {
          catalog: FIXTURE_CATALOG,
          demoAccount: FIXTURE_DEMO_ACCOUNT,
          manifest: {
            ...FIXTURE_MANIFEST,
            videoAssets: FIXTURE_MANIFEST.videoAssets.map((asset) => ({
              ...asset,
              renditions: asset.renditions
                .slice(-1)
                .map((rendition) => ({ ...rendition, width, height })),
            })),
          },
        },
      });
    for (const [width, height, quality] of [
      [1920, 800, "full-hd"],
      [1280, 536, "hd"],
      [960, 540, "sd"],
      [3840, 1600, "4k"],
    ] as const) {
      const t = await scope(width, height);
      const viewer = await demoViewer(t);
      expect((await t.services.browse.getTitle(viewer, "t-orbit")).bestVideoQuality).toBe(quality);
    }
  });
});
