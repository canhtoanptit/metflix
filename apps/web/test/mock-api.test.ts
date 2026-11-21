import { ApiError } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { createMockApiClient } from "../src/mocks/client.ts";
import { initialState } from "../src/mocks/state.ts";

/** The mock client validates every response against the contract schemas (validateResponses). */
function mockApi(scenario: Parameters<typeof initialState>[0] = "profile") {
  return createMockApiClient({
    state: initialState(scenario),
    settings: { latencyMs: 0, failing: [] },
  });
}

describe("mock API honours the contract", () => {
  it("answers every read route with contract-valid data", async () => {
    const api = mockApi();
    const browse = await api.getBrowse({ query: { view: "home" } });
    expect(browse.billboard).not.toBeNull();
    expect(new Set(browse.rows.map((row) => row.layout))).toEqual(
      new Set(["continue", "standard", "ranked", "tall"]),
    );
    const more = await api.getBrowse({
      query: { view: "home", cursor: browse.nextCursor ?? undefined },
    });
    expect(more.billboard).toBeNull();
    for (const view of ["series", "movies", "new-popular"] as const) {
      await api.getBrowse({ query: { view } });
    }
    const trending = browse.rows.find((row) => row.id === "home.trending");
    expect(trending?.nextCursor).not.toBeNull();
    await api.getBrowseRow({
      params: { rowId: "home.trending" },
      query: { cursor: trending?.nextCursor ?? undefined },
    });
    await api.listGenres();
    await api.getGenreBrowse({
      params: { slug: "drama" },
      query: { sort: "newest", type: "movie" },
    });
    const detail = await api.getTitle({ params: { id: "t-house-of-cinders" } });
    expect(detail.seasons.length).toBeGreaterThan(0);
    await api.listEpisodes({ params: { id: "t-house-of-cinders", seasonNumber: 1 } });
    await api.listSimilar({ params: { id: "t-sintel" } });
    const search = await api.search({ query: { q: "moon" } });
    expect(search.results.length).toBeGreaterThan(0);
    await api.getMyList();
    await api.getContinueWatching();
    await api.getHistory();
    await api.listNotifications();
    await api.getAccount();
    await api.listPlans();
    await api.listDevices();
    await api.listProfiles();
    await api.listAvatars();
    await api.createPlaybackSession({ body: { titleId: "t-sintel" } });
  });

  it("badges cards as the server does: Top 10 capped per list, never in progress or ranked rows", async () => {
    const api = mockApi();
    const cardsOf = (row: { layout: string; items: unknown[] }) =>
      (row.items as Array<{ title?: unknown }>).map(
        (item) => (item.title ?? item) as { id: string; badge: string | null; top10Rank?: number },
      );
    for (const view of ["home", "series", "movies", "new-popular"] as const) {
      let page = await api.getBrowse({ query: { view } });
      const rows = [...page.rows];
      while (page.nextCursor) {
        page = await api.getBrowse({ query: { view, cursor: page.nextCursor } });
        rows.push(...page.rows);
      }
      const ranked = rows.filter((row) => row.layout === "ranked");
      expect(ranked.length, `${view} has a Top 10 row`).toBeGreaterThan(0);
      if (view === "home")
        expect(ranked.map((row) => row.title)).toEqual(["Top 10 on Webflix Today"]);
      for (const row of rows) {
        const top10 = cardsOf(row).filter((card) => card.badge === "top-10").length;
        if (row.layout === "continue" || row.layout === "ranked") {
          expect(top10, `${view}: ${row.title}`).toBe(0);
        } else {
          expect(top10, `${view}: ${row.title}`).toBeLessThanOrEqual(2);
        }
        // A Top 10 badge always names a rank in the view's list.
        for (const card of cardsOf(row)) {
          if (card.badge === "top-10") expect(card.top10Rank).toBeGreaterThan(0);
        }
      }
      // Every card the view's ranked row shows says its rank, badge or not.
      const first = ranked[0];
      const list = view === "new-popular" || !first ? [] : cardsOf(first);
      for (const [index, card] of list.entries()) expect(card.top10Rank).toBe(index + 1);
    }
    const genre = await api.getGenreBrowse({ params: { slug: "drama" }, query: {} });
    expect(genre.items.filter((card) => card.badge === "top-10").length).toBeLessThanOrEqual(2);
    for (const card of genre.items) expect(card.bestVideoQuality).toBeDefined();
  });

  it("applies mutations to later reads", async () => {
    const api = mockApi();
    await api.addToMyList({ params: { titleId: "t-parallax" } });
    expect((await api.getTitle({ params: { id: "t-parallax" } })).viewer.inMyList).toBe(true);
    await api.rateTitle({ params: { titleId: "t-parallax" }, body: { value: "love" } });
    expect((await api.getTitle({ params: { id: "t-parallax" } })).viewer.rating).toBe("love");
    await api.removeFromMyList({ params: { titleId: "t-parallax" } });
    expect((await api.getMyList()).items.some((item) => item.id === "t-parallax")).toBe(false);
  });

  it("answers problems with stable codes", async () => {
    const anonymous = mockApi("anonymous");
    await expect(anonymous.getBrowse({ query: {} })).rejects.toSatisfy((error) =>
      ApiError.is(error, "unauthenticated"),
    );
    await expect(
      anonymous.login({ body: { email: "demo@webflix.dev", password: "nope" } }),
    ).rejects.toSatisfy((error) => ApiError.is(error, "invalid_credentials"));
    const session = await anonymous.login({
      body: { email: "demo@webflix.dev", password: "webflix-demo" },
    });
    expect(session.activeProfile).toBeNull();
    await expect(anonymous.getBrowse({ query: {} })).rejects.toSatisfy((error) =>
      ApiError.is(error, "profile_required"),
    );
    const theo = session.profiles.find((profile) => profile.isLocked);
    if (!theo) throw new Error("expected a locked profile");
    await expect(
      anonymous.selectProfile({ body: { profileId: theo.id, pin: "0000" } }),
    ).rejects.toSatisfy((error) => ApiError.is(error, "profile_pin_invalid"));
    const selected = await anonymous.selectProfile({ body: { profileId: theo.id, pin: "1234" } });
    expect(selected.activeProfile?.name).toBe("Theo");
  });

  it("filters the catalogue by the kids profile's maturity ceiling", async () => {
    const api = mockApi("account");
    const session = await api.getSession();
    if (!session.authenticated) throw new Error("expected a session");
    const kids = session.profiles.find((profile) => profile.isKids);
    if (!kids) throw new Error("expected a kids profile");
    await api.selectProfile({ body: { profileId: kids.id } });
    const browse = await api.getBrowse({ query: {} });
    const levels = browse.rows.flatMap((row) =>
      row.items.map((item) => ("title" in item ? item.title.maturity : item.maturity)),
    );
    expect(levels.every((level) => level === "ALL" || level === "7+")).toBe(true);
    await expect(api.getTitle({ params: { id: "t-cold-ledger" } })).rejects.toSatisfy((error) =>
      ApiError.is(error, "maturity_restricted"),
    );
  });

  it("can fail chosen endpoints for error-state work", async () => {
    const api = createMockApiClient({
      state: initialState("profile"),
      settings: { latencyMs: 0, failing: ["getBrowse"] },
    });
    await expect(api.getBrowse({ query: {} })).rejects.toSatisfy((error) =>
      ApiError.is(error, "internal_error"),
    );
  });
});
