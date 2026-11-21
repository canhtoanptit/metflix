import { QueryClient } from "@tanstack/react-query";
import type {
  BrowsePage,
  ContinueWatchingList,
  MyListPage,
  Row,
  TitleCard,
} from "@webflix/contracts";
import { makeRow, makeTitleCard, resetFixtures } from "@webflix/contracts/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { qk } from "../src/app/query/keys.ts";
import {
  formatLength,
  formatProgress,
  formatRuntime,
  qualityLabel,
  rankLabel,
  relativeTime,
  top10RankLabel,
} from "../src/features/browse/common/format.ts";
import { watchLink } from "../src/features/browse/common/watch.ts";
import {
  findCachedCard,
  patchMyListMembership,
  removeContinueWatching,
} from "../src/features/browse/library/cache.ts";
import { previewGeometry } from "../src/features/browse/preview/geometry.ts";
import { cardOf, mergeRow } from "../src/features/browse/preview/request.ts";

beforeEach(() => resetFixtures());

describe("format", () => {
  it("formats runtimes like the rest of the product", () => {
    expect(formatRuntime(45)).toBe("45s");
    expect(formatRuntime(47 * 60)).toBe("47m");
    expect(formatRuntime(112 * 60)).toBe("1h 52m");
    expect(formatRuntime(120 * 60)).toBe("2h");
  });

  it("shows runtime for movies and seasons for series", () => {
    expect(formatLength({ type: "movie", runtimeSec: 6000, seasonCount: null })).toBe("1h 40m");
    expect(formatLength({ type: "series", runtimeSec: null, seasonCount: 1 })).toBe("1 Season");
    expect(formatLength({ type: "series", runtimeSec: null, seasonCount: 3 })).toBe("3 Seasons");
  });

  it("formats progress as watched of total minutes", () => {
    expect(formatProgress({ positionSec: 22 * 60, durationSec: 53 * 60 })).toBe("22 of 53m");
  });

  it("turns ranked row titles into a rank label", () => {
    expect(rankLabel(2, "Top 10 Series Today")).toBe("#2 in Series Today");
    expect(rankLabel(1, "Top 10 on Webflix Today")).toBe("#1 on Webflix Today");
    expect(rankLabel(3, "Most watched")).toBe("#3 in Most watched");
  });

  it("states a card's Top 10 rank in the words of its view's Top 10 row", () => {
    const movie = { type: "movie" as const, top10Rank: 3 };
    const series = { type: "series" as const, top10Rank: 2 };
    expect(top10RankLabel(movie, "home")).toBe("#3 on Webflix Today");
    expect(top10RankLabel(movie, null)).toBe("#3 on Webflix Today");
    expect(top10RankLabel(series, "series")).toBe("#2 in Series Today");
    expect(top10RankLabel(movie, "movies")).toBe("#3 in Movies Today");
    expect(top10RankLabel(series, "new-popular")).toBe("#2 in Series Today");
    expect(top10RankLabel({ type: "movie" }, "home")).toBeNull();
  });

  it("labels quality as the lower of the title's best and the plan's cap, never a guess", () => {
    expect(qualityLabel({ bestVideoQuality: "4k" }, { maxVideoHeight: 2160 })).toBe("4K");
    expect(qualityLabel({ bestVideoQuality: "4k" }, { maxVideoHeight: 1080 })).toBe("Full HD");
    expect(qualityLabel({ bestVideoQuality: "full-hd" }, { maxVideoHeight: 720 })).toBe("HD");
    expect(qualityLabel({ bestVideoQuality: "hd" }, { maxVideoHeight: 2160 })).toBe("HD");
    expect(qualityLabel({}, { maxVideoHeight: 2160 })).toBeNull();
  });

  it("formats notification times relative to now", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    expect(relativeTime("2026-11-21T11:59:30Z", now)).toBe("Just now");
    expect(relativeTime("2026-11-21T11:15:00Z", now)).toBe("45m ago");
    expect(relativeTime("2026-11-21T07:00:00Z", now)).toBe("5h ago");
    expect(relativeTime("2026-11-20T10:00:00Z", now)).toBe("Yesterday");
    expect(relativeTime("2026-11-18T12:00:00Z", now)).toBe("3d ago");
  });

  it("builds watch links with an optional episode and start time", () => {
    expect(watchLink("t-a")).toEqual({
      to: "/watch/$titleId",
      params: { titleId: "t-a" },
      search: {},
    });
    expect(watchLink("t-a", { episodeId: "e-1", t: 12.6 }).search).toEqual({
      episode: "e-1",
      t: 13,
    });
  });
});

describe("hover preview geometry", () => {
  const base = {
    viewport: { width: 1440, height: 900 },
    gutter: 57.6,
    navHeight: 68,
  };
  const card = { left: 500, top: 500, width: 220, height: (220 * 9) / 16 };

  /** Where the picture's box lands when the preview is scaled by fromScale about its origin. */
  function scaledPicture(g: ReturnType<typeof previewGeometry>) {
    const map = (x: number, origin: number) => origin + g.fromScale * (x - origin);
    return {
      left: g.left + map(0, g.originX),
      right: g.left + map(g.width, g.originX),
      top: g.top + map(0, g.originY),
      bottom: g.top + map(g.mediaHeight, g.originY),
    };
  }

  it("centres a middle card's preview and starts exactly on the card", () => {
    const g = previewGeometry({ ...base, rect: card, edge: null });
    expect(g.width).toBeCloseTo(330);
    expect(g.left + g.width / 2).toBeCloseTo(card.left + card.width / 2);
    const picture = scaledPicture(g);
    expect(picture.left).toBeCloseTo(card.left);
    expect(picture.right).toBeCloseTo(card.left + card.width);
    expect(picture.top).toBeCloseTo(card.top);
    expect(picture.bottom).toBeCloseTo(card.top + card.height);
  });

  it("expands inward from the first and last visible cards", () => {
    const first = previewGeometry({ ...base, rect: { ...card, left: 57.6 }, edge: "start" });
    expect(first.left).toBeCloseTo(57.6);
    expect(first.originX).toBeCloseTo(0);
    const lastLeft = 1440 - 57.6 - 220;
    const last = previewGeometry({ ...base, rect: { ...card, left: lastLeft }, edge: "end" });
    expect(last.left + last.width).toBeCloseTo(lastLeft + 220);
    expect(last.originX).toBeCloseTo(last.width);
  });

  it("never crosses the gutters, even for a card that is not marked as an edge", () => {
    const g = previewGeometry({ ...base, rect: { ...card, left: 60 }, edge: null });
    expect(g.left).toBeGreaterThanOrEqual(57.6);
    const h = previewGeometry({ ...base, rect: { ...card, left: 1440 - 70 - 220 }, edge: null });
    expect(h.left + h.width).toBeLessThanOrEqual(1440 - 57.6 + 0.001);
  });

  it("stays below the navigation and above the bottom of the viewport", () => {
    const high = previewGeometry({ ...base, rect: { ...card, top: 40 }, edge: null });
    expect(high.top).toBeGreaterThanOrEqual(68);
    const low = previewGeometry({ ...base, rect: { ...card, top: 800 }, edge: null, height: 330 });
    expect(low.top + 330).toBeLessThanOrEqual(900);
    // The grow still starts from the card itself, wherever the box had to move.
    const picture = scaledPicture(low);
    expect((picture.left + picture.right) / 2).toBeCloseTo(card.left + card.width / 2);
    expect((picture.top + picture.bottom) / 2).toBeCloseTo(800 + card.height / 2);
  });

  it("keeps a usable width on narrow windows", () => {
    const g = previewGeometry({
      viewport: { width: 520, height: 800 },
      gutter: 20.8,
      navHeight: 68,
      rect: { left: 21, top: 300, width: 160, height: 90 },
      edge: "start",
    });
    expect(g.width).toBeGreaterThanOrEqual(300);
    expect(g.left + g.width).toBeLessThanOrEqual(520 - 20.8);
  });
});

function infinite<T>(...pages: T[]) {
  return { pages, pageParams: pages.map((_, index) => index) };
}

describe("library cache surgery", () => {
  it("adds to and removes from the My List page", () => {
    const a = makeTitleCard();
    const b = makeTitleCard();
    const data = infinite<MyListPage>({ items: [a], nextCursor: null });
    const added = patchMyListMembership(data, qk.profile.myList(), b.id, b, true) as typeof data;
    expect(added.pages[0]?.items.map((card) => card.id)).toEqual([b.id, a.id]);
    expect(added.pages[0]?.items[0]?.viewer.inMyList).toBe(true);
    const removed = patchMyListMembership(
      added,
      qk.profile.myList(),
      a.id,
      null,
      false,
    ) as typeof data;
    expect(removed.pages[0]?.items.map((card) => card.id)).toEqual([b.id]);
  });

  it("changes only the My List row of a browse page, keeping other rows untouched", () => {
    const listed = makeTitleCard();
    const other = makeTitleCard();
    const myList: Row = { ...makeRow("standard"), kind: "my-list", items: [listed] };
    const trending = makeRow("standard");
    const page: BrowsePage = {
      view: "home",
      billboard: null,
      rows: [myList, trending],
      nextCursor: null,
    };
    const data = infinite(page);
    const next = patchMyListMembership(
      data,
      qk.profile.browse("home"),
      other.id,
      other,
      true,
    ) as typeof data;
    expect(next.pages[0]?.rows[0]?.items).toHaveLength(2);
    expect(next.pages[0]?.rows[1]).toBe(trending);
    const unchanged = patchMyListMembership(data, qk.profile.browse("home"), "t-nope", null, false);
    expect(unchanged).toBe(data);
  });

  it("removes a title from every Continue Watching row and list", () => {
    const row = makeRow("continue");
    if (row.layout !== "continue") throw new Error("fixture");
    const target = row.items[0]?.title.id ?? "";
    const page: BrowsePage = { view: "home", billboard: null, rows: [row], nextCursor: null };
    const browse = removeContinueWatching(infinite(page), qk.profile.browse("home"), target) as {
      pages: BrowsePage[];
    };
    const items = browse.pages[0]?.rows[0]?.items as Array<{ title: TitleCard }>;
    expect(items.some((item) => item.title.id === target)).toBe(false);
    const list: ContinueWatchingList = { items: row.items };
    const next = removeContinueWatching(
      list,
      qk.profile.continueWatching(),
      target,
    ) as ContinueWatchingList;
    expect(next.items).toHaveLength(row.items.length - 1);
  });

  it("finds the freshest cached card for a title anywhere in the profile cache", () => {
    const queryClient = new QueryClient();
    const card = makeTitleCard();
    queryClient.setQueryData(
      qk.profile.browse("home"),
      infinite<BrowsePage>({
        view: "home",
        billboard: null,
        rows: [{ ...makeRow("standard"), items: [card] }],
        nextCursor: null,
      }),
    );
    expect(findCachedCard(queryClient, card.id)?.name).toBe(card.name);
    expect(findCachedCard(queryClient, "t-missing")).toBeNull();
  });
});

describe("row pages", () => {
  it("appends further pages to a row without duplicating titles", () => {
    const first = makeRow("standard");
    if (first.layout !== "standard") throw new Error("fixture");
    const extra = makeTitleCard();
    const second: Row = { ...first, items: [first.items[0] as TitleCard, extra], nextCursor: null };
    const merged = mergeRow(first, [second]);
    expect(merged.items).toHaveLength(first.items.length + 1);
    expect(merged.nextCursor).toBeNull();
    expect(cardOf(merged.items.at(-1) as TitleCard).id).toBe(extra.id);
  });
});
