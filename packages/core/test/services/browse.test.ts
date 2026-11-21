import { describe, expect, it } from "vitest";
import { AppError, DAY_MS, isWithinMaturityCeiling } from "../../src/index.ts";
import { createTestServices, FIXTURE_CATALOG } from "../../src/testing/index.ts";
import { demoViewer, titleIdsOf } from "./helpers.ts";

const maturityOf = new Map(FIXTURE_CATALOG.titles.map((title) => [title.id, title.maturity]));

async function allRows(
  browse: Awaited<ReturnType<typeof createTestServices>>["services"]["browse"],
  viewer: Awaited<ReturnType<typeof demoViewer>>,
  view: "home" | "series" | "movies" | "new-popular",
) {
  const first = await browse.getBrowse(viewer, view, undefined);
  const rows = [...first.rows];
  let cursor = first.nextCursor;
  while (cursor) {
    const next = await browse.getBrowse(viewer, view, cursor);
    expect(next.billboard).toBeNull();
    rows.push(...next.rows);
    cursor = next.nextCursor;
  }
  return { billboard: first.billboard, rows };
}

describe("browse and recommendations", () => {
  it("gives the seeded demo profile a full home page", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const page = await allRows(t.services.browse, viewer, "home");
    const kinds = page.rows.map((row) => row.kind);

    expect(page.billboard).not.toBeNull();
    expect(page.billboard?.playTarget).not.toBeNull();
    expect(page.rows.length).toBeGreaterThanOrEqual(12);
    expect(kinds[0]).toBe("continue-watching");
    expect(kinds).toContain("top-10");
    expect(kinds).toContain("trending");
    expect(kinds).toContain("my-list");
    expect(kinds).toContain("because-you-watched");
    expect(kinds).toContain("new-releases");
    expect(kinds).toContain("originals");
    expect(kinds).toContain("watch-again");
    expect(kinds.filter((kind) => kind === "genre").length).toBeGreaterThanOrEqual(3);
    expect(new Set(page.rows.map((row) => row.id)).size).toBe(page.rows.length);

    const top10 = page.rows.find((row) => row.kind === "top-10");
    expect(top10?.layout).toBe("ranked");
    if (top10?.layout === "ranked") {
      expect(top10.items.map((item) => item.rank)).toEqual(
        top10.items.map((_, index) => index + 1),
      );
      expect(top10.items.length).toBe(10);
    }
    const originals = page.rows.find((row) => row.kind === "originals");
    expect(originals?.layout).toBe("tall");
  });

  it("is deterministic for the same inputs", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const a = await allRows(t.services.browse, viewer, "home");
    const b = await allRows(t.services.browse, viewer, "home");
    expect(b).toEqual(a);
  });

  it("builds Continue Watching from progress: resume points and next episodes", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const { items } = await t.services.library.continueWatching(viewer);
    const byTitle = new Map(items.map((item) => [item.title.id, item]));

    // Saltwater Kings: 42% in, watched yesterday (most recent first). Seeded progress is
    // measured on the stream Play opens (the fixture's 600 s fallback), not the catalog runtime.
    expect(items[0]?.title.id).toBe("t-saltwater");
    expect(byTitle.get("t-saltwater")?.episode).toBeNull();
    expect(byTitle.get("t-saltwater")?.progress).toMatchObject({
      positionSec: Math.round(600 * 0.42),
      durationSec: 600,
    });
    // Kestrel: S1E2 in progress.
    expect(byTitle.get("t-kestrel")?.episode).toMatchObject({ seasonNumber: 1, number: 2 });
    // Lost Signal: S1E2 finished, so S2E1 is next, from the start.
    expect(byTitle.get("t-signal")?.episode).toMatchObject({ seasonNumber: 2, number: 1 });
    expect(byTitle.get("t-signal")?.progress.positionSec).toBe(0);
    // Finished movies are not in Continue Watching.
    expect(byTitle.has("t-orbit")).toBe(false);

    await t.services.library.removeFromContinueWatching(viewer, "t-saltwater");
    const after = await t.services.library.continueWatching(viewer);
    expect(after.items.map((item) => item.title.id)).not.toContain("t-saltwater");
  });

  it("keeps disliked titles out of rows and lowers their match", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const page = await allRows(t.services.browse, viewer, "home");
    expect(titleIdsOf(page)).not.toContain("t-copper");
    const detail = await t.services.browse.getTitle(viewer, "t-copper");
    expect(detail.viewer.rating).toBe("dislike");
    expect(detail.matchScore ?? 0).toBeLessThanOrEqual(55);
  });

  it("keeps dislikes out of a row served from an older cursor, not in today's plan", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    // Too few thrillers among six series for a Series row: only an older link reaches it.
    const series = await allRows(t.services.browse, viewer, "series");
    expect(series.rows.map((row) => row.id)).not.toContain("series:genre:thriller");
    const before = await t.services.browse.getRow(viewer, "series:genre:thriller", undefined, 20);
    const ids = (row: typeof before) => row.items.map((item) => ("id" in item ? item.id : ""));
    expect(ids(before)).toContain("t-signal");
    await t.services.library.rate(viewer, "t-signal", "dislike");
    const after = await t.services.browse.getRow(viewer, "series:genre:thriller", undefined, 20);
    expect(ids(after)).not.toContain("t-signal");
  });

  it("keeps a disliked original out of the originals rows of every view", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const originals = async () => {
      const ids: string[] = [];
      for (const view of ["home", "series", "movies", "new-popular"] as const) {
        const page = await allRows(t.services.browse, viewer, view);
        for (const row of page.rows.filter((candidate) => candidate.kind === "originals")) {
          for (const item of row.items) ids.push("title" in item ? item.title.id : item.id);
        }
      }
      return ids;
    };
    const before = await originals();
    const target = before[0];
    if (!target) throw new Error("the fixture catalog should produce an originals row");
    await t.services.library.rate(viewer, target, "dislike");
    expect(await originals()).not.toContain(target);
  });

  it("scores matches from taste: close to what was loved, far from the unrelated", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const signal = await t.services.browse.getTitle(viewer, "t-signal");
    const documentary = await t.services.browse.getTitle(viewer, "t-wild");
    expect(signal.matchScore).not.toBeNull();
    expect(signal.matchScore ?? 0).toBeGreaterThan(documentary.matchScore ?? 100);
    for (const score of [signal.matchScore, documentary.matchScore]) {
      expect(score).toBeGreaterThanOrEqual(50);
      expect(score).toBeLessThanOrEqual(98);
    }
  });

  it("explains Because You Watched with similar titles", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const page = await allRows(t.services.browse, viewer, "home");
    const because = page.rows.filter((row) => row.kind === "because-you-watched");
    expect(because.length).toBeGreaterThanOrEqual(1);
    for (const row of because) {
      const source = row.context.sourceTitle;
      expect(source).not.toBeNull();
      expect(row.title).toBe(`Because You Watched ${source?.name}`);
      const sourceGenres = new Set(
        FIXTURE_CATALOG.titles.find((title) => title.id === source?.id)?.genreIds,
      );
      const first = row.items[0] as { id: string; genres: { slug: string }[] };
      expect(first.id).not.toBe(source?.id);
      // The top recommendation shares a genre with the source.
      const firstGenres =
        FIXTURE_CATALOG.titles.find((title) => title.id === first.id)?.genreIds ?? [];
      expect(firstGenres.some((genre) => sourceGenres.has(genre))).toBe(true);
    }
  });

  it("filters every surface by the kids profile's maturity ceiling", async () => {
    const t = await createTestServices();
    const kids = await demoViewer(t, "pr-kids");
    for (const view of ["home", "series", "movies", "new-popular"] as const) {
      const page = await allRows(t.services.browse, kids, view);
      for (const id of titleIdsOf(page)) {
        expect(isWithinMaturityCeiling(maturityOf.get(id) ?? "18+", "7+"), `${view}: ${id}`).toBe(
          true,
        );
      }
    }
    const genres = await t.services.browse.listGenres(kids);
    expect(genres.items.map((genre) => genre.slug)).not.toContain("horror");
    const similar = await t.services.browse.listSimilar(kids, "t-owl");
    for (const card of similar.items)
      expect(isWithinMaturityCeiling(card.maturity, "7+")).toBe(true);
    await expect(t.services.browse.getTitle(kids, "t-ferry")).rejects.toMatchObject({
      code: "maturity_restricted",
      extensions: { maturity: "18+", profileMaturityCeiling: "7+" },
    });
    await expect(t.services.browse.listEpisodes(kids, "t-hollow", 1)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("treats a profile without signals as cold: popular rows, no match score", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t, "pr-locked");
    const page = await allRows(t.services.browse, viewer, "home");
    const kinds = page.rows.map((row) => row.kind);
    expect(kinds).not.toContain("continue-watching");
    expect(kinds).not.toContain("because-you-watched");
    expect(kinds).toContain("top-10");
    expect(kinds).toContain("genre");
    const card = page.rows.find((row) => row.kind === "trending")?.items[0] as {
      matchScore: number | null;
    };
    expect(card.matchScore).toBeNull();
  });

  it("rotates the billboard daily, stable within a day, never a finished or disliked title", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const seen = new Set<string>();
    for (let day = 0; day < 6; day += 1) {
      const first = await t.services.browse.getBrowse(viewer, "home", undefined);
      const again = await t.services.browse.getBrowse(viewer, "home", undefined);
      expect(again.billboard?.title.id).toBe(first.billboard?.title.id);
      const id = first.billboard?.title.id ?? "";
      expect(["t-orbit", "t-bloom", "t-copper"]).not.toContain(id);
      seen.add(id);
      t.clock.advance(DAY_MS);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("pages rows and genre pages with cursors", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const home = await t.services.browse.getBrowse(viewer, "home", undefined);
    const trending = home.rows.find((row) => row.kind === "trending");
    if (!trending) throw new Error("no trending row");
    const page1 = await t.services.browse.getRow(viewer, trending.id, undefined, 5);
    expect(page1.items).toHaveLength(5);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await t.services.browse.getRow(
      viewer,
      trending.id,
      page1.nextCursor ?? undefined,
      5,
    );
    const ids = (row: typeof page1) => row.items.map((item) => (item as { id: string }).id);
    expect(ids(page2).some((id) => ids(page1).includes(id))).toBe(false);
    await expect(t.services.browse.getRow(viewer, "home:nope", undefined, 5)).rejects.toMatchObject(
      {
        code: "not_found",
      },
    );
    await expect(t.services.browse.getRow(viewer, trending.id, "!!bad", 5)).rejects.toMatchObject({
      code: "validation_failed",
    });

    const az = await t.services.browse.getGenrePage(viewer, "drama", { sort: "a-z", limit: 3 });
    expect(az.items.map((item) => item.name)).toEqual(
      [...az.items.map((item) => item.name)].sort((a, b) => a.localeCompare(b)),
    );
    const rest = await t.services.browse.getGenrePage(viewer, "drama", {
      sort: "a-z",
      limit: 50,
      cursor: az.nextCursor ?? undefined,
    });
    expect(rest.items[0]?.name.localeCompare(az.items[2]?.name ?? "")).toBeGreaterThan(0);
    const series = await t.services.browse.getGenrePage(viewer, "drama", { type: "series" });
    expect(series.items.every((item) => item.type === "series")).toBe(true);
    await expect(t.services.browse.getGenrePage(viewer, "nope", {})).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("serves every row once across batches when the plan changes between them", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const first = await t.services.browse.getBrowse(viewer, "home", undefined);
    const served = first.rows.map((row) => row.id);
    const myList = first.rows.find((row) => row.kind === "my-list");
    if (!myList || !first.nextCursor) throw new Error("the demo home needs My List in batch one");
    // Emptying My List drops its row from the plan: every later row moves up by one.
    for (const item of myList.items) {
      await t.services.library.removeFromMyList(viewer, (item as { id: string }).id);
    }
    let cursor: string | null = first.nextCursor;
    while (cursor) {
      const next = await t.services.browse.getBrowse(viewer, "home", cursor);
      served.push(...next.rows.map((row) => row.id));
      cursor = next.nextCursor;
    }
    const plan = (await allRows(t.services.browse, viewer, "home")).rows.map((row) => row.id);
    expect(new Set(served).size).toBe(served.length);
    expect(plan.filter((id) => !served.includes(id))).toEqual([]);
  });

  it("pages a row without repeats when it changes between pages", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const rowId = "home:my-list";
    const page1 = await t.services.browse.getRow(viewer, rowId, undefined, 2);
    const ids = (row: typeof page1) => row.items.map((item) => (item as { id: string }).id);
    expect(page1.nextCursor).not.toBeNull();
    // A title added now goes to the front: an offset would serve page one's last item again.
    const home = await t.services.browse.getBrowse(viewer, "home", undefined);
    const added = home.rows
      .flatMap((row) => row.items as Array<{ id?: string }>)
      .map((item) => item.id)
      .find((id): id is string => typeof id === "string" && !ids(page1).includes(id));
    if (!added) throw new Error("no title to add");
    await t.services.library.addToMyList(viewer, added);
    const page2 = await t.services.browse.getRow(viewer, rowId, page1.nextCursor ?? undefined, 2);
    expect(ids(page2).filter((id) => ids(page1).includes(id))).toEqual([]);
    expect(ids(page2)).toContain(added);
  });

  it("returns title detail with viewer state, play target and seasons", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const kestrel = await t.services.browse.getTitle(viewer, "t-kestrel");
    expect(kestrel.seasons.map((season) => season.episodeCount)).toEqual([3, 2]);
    expect(kestrel.playTarget).toMatchObject({
      action: "resume",
      episode: { seasonNumber: 1, number: 2 },
    });
    // 30% of the 90 min packaged stream the episode plays.
    expect(kestrel.viewer.progress?.positionSec).toBe(1620);
    expect(kestrel.creators).toEqual([{ id: "p-eli", name: "Eli Sandström" }]);

    const glasshouse = await t.services.browse.getTitle(viewer, "t-glasshouse");
    expect(glasshouse.viewer).toEqual({ inMyList: true, rating: null, progress: null });
    expect(glasshouse.playTarget).toMatchObject({ action: "play", positionSec: 0 });

    const episodes = await t.services.browse.listEpisodes(viewer, "t-kestrel", 1);
    expect(episodes.items.map((episode) => episode.progress?.completed ?? null)).toEqual([
      true,
      false,
      null,
    ]);
    await expect(t.services.browse.listEpisodes(viewer, "t-kestrel", 9)).rejects.toMatchObject({
      code: "not_found",
    });

    // Not packaged and no fallback of its own: plays the catalog's fallback stream.
    const tides = await t.services.browse.getTitle(viewer, "t-tides");
    expect(tides.isPlayable).toBe(true);
    expect(tides.playTarget).toMatchObject({ action: "play" });
  });
});
