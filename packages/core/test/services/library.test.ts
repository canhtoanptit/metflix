import type { CatalogSeed } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { buildCatalogWrite, SEED_HASH_KEY } from "../../src/index.ts";
import { createMemoryRepositories } from "../../src/memory/index.ts";
import {
  createTestServices,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_EXTERNAL_URL,
  FIXTURE_MANIFEST,
  TEST_NOW,
} from "../../src/testing/index.ts";
import { demoViewer, memberViewer } from "./helpers.ts";

function withoutStreams(): CatalogSeed {
  return {
    ...FIXTURE_CATALOG,
    videoAssets: FIXTURE_CATALOG.videoAssets.map((asset) => ({ ...asset, externalHlsUrl: null })),
  };
}

describe("library", () => {
  it("keeps My List, newest first, and refuses titles above the ceiling", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    t.clock.advance(1000);
    await t.services.library.addToMyList(viewer, "t-bloom");
    await t.services.library.addToMyList(viewer, "t-bloom");
    const list = await t.services.library.getMyList(viewer, undefined, undefined);
    expect(list.items.map((card) => card.id)).toEqual([
      "t-bloom",
      "t-glasshouse",
      "t-starlings",
      "t-lanterns",
    ]);
    expect(list.items.every((card) => card.viewer.inMyList)).toBe(true);

    const page = await t.services.library.getMyList(viewer, undefined, 2);
    const next = await t.services.library.getMyList(viewer, page.nextCursor ?? undefined, 2);
    expect([...page.items, ...next.items].map((card) => card.id)).toEqual(
      list.items.map((card) => card.id),
    );
    expect(next.nextCursor).toBeNull();

    await t.services.library.removeFromMyList(viewer, "t-bloom");
    await t.services.library.removeFromMyList(viewer, "t-bloom");
    expect((await t.services.library.getMyList(viewer, undefined, undefined)).items).toHaveLength(
      3,
    );

    const kids = await demoViewer(t, "pr-kids");
    await expect(t.services.library.addToMyList(kids, "t-ferry")).rejects.toMatchObject({
      code: "maturity_restricted",
    });
    await expect(t.services.library.addToMyList(kids, "t-missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rates titles and reflects the rating on cards", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    await t.services.library.rate(viewer, "t-glasshouse", "love");
    expect((await t.services.browse.getTitle(viewer, "t-glasshouse")).viewer.rating).toBe("love");
    await t.services.library.clearRating(viewer, "t-glasshouse");
    expect((await t.services.browse.getTitle(viewer, "t-glasshouse")).viewer.rating).toBeNull();
  });

  it("pages viewing activity and removes entries with their progress", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const all = await t.services.library.history(viewer, undefined, 50);
    expect(all.items.map((entry) => entry.title.id)).toEqual([
      "t-saltwater",
      "t-kestrel",
      "t-kestrel",
      "t-signal",
      "t-orbit",
      "t-bloom",
    ]);
    expect(all.items[1]?.episode).toMatchObject({ seasonNumber: 1, number: 2 });

    const first = await t.services.library.history(viewer, undefined, 4);
    const rest = await t.services.library.history(viewer, first.nextCursor ?? undefined, 4);
    expect([...first.items, ...rest.items].map((entry) => entry.id)).toEqual(
      all.items.map((entry) => entry.id),
    );

    const saltwater = all.items[0];
    if (!saltwater) throw new Error("no history");
    await t.services.library.removeHistoryEntry(viewer, saltwater.id);
    const cw = await t.services.library.continueWatching(viewer);
    expect(cw.items.map((item) => item.title.id)).not.toContain("t-saltwater");
    await expect(t.services.library.removeHistoryEntry(viewer, saltwater.id)).rejects.toMatchObject(
      {
        code: "not_found",
      },
    );
    await expect(t.services.library.history(viewer, "garbage!", 5)).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("lists recent arrivals as notifications per profile, maturity-filtered, with read state", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const list = await t.services.library.notifications(viewer);
    expect(list.items.length).toBeGreaterThan(3);
    expect(list.unreadCount).toBe(list.items.length);
    expect(list.items[0]?.title?.id).toBe("t-orbit");
    expect(list.items[0]?.image?.template).toContain("/cdn/img/titles/t-orbit/card-");

    const kids = await demoViewer(t, "pr-kids");
    const kidsList = await t.services.library.notifications(kids);
    expect(kidsList.items.map((item) => item.title?.id)).not.toContain("t-ferry");
    expect(kidsList.items.map((item) => item.title?.id)).toContain("t-meadow");

    const firstId = list.items[0]?.id ?? "";
    await t.services.library.markNotificationsRead(viewer, [firstId]);
    expect((await t.services.library.notifications(viewer)).unreadCount).toBe(
      list.items.length - 1,
    );
    await t.services.library.markNotificationsRead(viewer, undefined);
    expect((await t.services.library.notifications(viewer)).unreadCount).toBe(0);
    // Read state is per profile.
    expect((await t.services.library.notifications(kids)).unreadCount).toBe(kidsList.unreadCount);
  });
});

describe("notifications of a new profile", () => {
  it("open with no backlog: a few earlier arrivals, already read; later ones unread", async () => {
    const t = await createTestServices();
    const me = await memberViewer(t);
    const first = await t.services.library.notifications(me);
    expect(first.unreadCount).toBe(0);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThanOrEqual(3);
    expect(first.items.every((item) => item.readAt !== null)).toBe(true);
    // The latest arrivals from before the profile existed, newest first.
    const older = await t.services.library.notifications(await demoViewer(t));
    expect(first.items.map((item) => item.id)).toEqual(
      older.items.slice(0, first.items.length).map((item) => item.id),
    );
    // What arrives afterwards is news to it: a title added after the profile was created.
    t.clock.advance(60_000);
    const catalog = {
      ...FIXTURE_CATALOG,
      titles: FIXTURE_CATALOG.titles.map((title) =>
        title.id === "t-owl" ? { ...title, addedDaysAgo: 0 } : title,
      ),
    };
    await t.services.seeder.seed(
      { catalog, demoAccount: FIXTURE_DEMO_ACCOUNT, manifest: FIXTURE_MANIFEST },
      { force: true },
    );
    const later = await t.services.library.notifications(me);
    expect(later.unreadCount).toBe(1);
    expect(later.items[0]).toMatchObject({ title: { id: "t-owl" }, readAt: null });
  });
});

describe("search", () => {
  it("finds titles as you type, with suggestions, filtered by maturity", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const results = await t.services.search.search(viewer, { q: "kest" });
    expect(results.results[0]?.id).toBe("t-kestrel");
    expect(results.results[0]?.viewer).toEqual({ inMyList: false, rating: null });
    expect(results.suggestions).toContainEqual({
      kind: "title",
      id: "t-kestrel",
      name: "Night Shift at Kestrel Bay",
    });

    const person = await t.services.search.search(viewer, { q: "jon ash" });
    expect(person.results.map((card) => card.id).sort()).toEqual([
      "t-cellar",
      "t-ferry",
      "t-hollow",
    ]);
    expect(person.suggestions).toContainEqual({
      kind: "person",
      id: "p-jon",
      name: "Jon Ashgrove",
    });

    const kids = await demoViewer(t, "pr-kids");
    const kidsResults = await t.services.search.search(kids, { q: "jon" });
    expect(kidsResults.results).toEqual([]);
    expect(kidsResults.suggestions).toEqual([]);

    const genre = await t.services.search.search(viewer, { q: "documen" });
    expect(genre.suggestions).toContainEqual({
      kind: "genre",
      slug: "documentary",
      name: "Documentaries",
    });

    const paged = await t.services.search.search(viewer, { q: "a", limit: 3 });
    expect(paged.results).toHaveLength(3);
    const next = await t.services.search.search(viewer, {
      q: "a",
      limit: 3,
      cursor: paged.nextCursor ?? undefined,
    });
    expect(next.suggestions).toEqual([]);
    expect(
      next.results
        .map((card) => card.id)
        .some((id) => paged.results.some((card) => card.id === id)),
    ).toBe(false);
  });
});

describe("seeding", () => {
  it("maps packaged, external and unavailable media and falls back for missing artwork", () => {
    const write = buildCatalogWrite(FIXTURE_CATALOG, FIXTURE_MANIFEST, TEST_NOW, "v");
    const assets = new Map(write.videoAssets.map((asset) => [asset.id, asset]));
    expect(assets.get("v-pkg")).toMatchObject({
      kind: "packaged",
      masterKey: "vod/v-pkg/master.m3u8",
      maxHeight: 1080,
    });
    expect(assets.get("v-ext")).toMatchObject({ kind: "external", masterKey: null });
    // No stream of its own and no sibling from the same source: the catalog's first stream.
    expect(assets.get("v-none")).toMatchObject({
      kind: "external",
      externalUrl: FIXTURE_EXTERNAL_URL,
    });

    const titles = new Map(write.titles.map((title) => [title.id, title]));
    expect(titles.get("t-orbit")?.images.card.template).toBe(
      "/cdn/img/titles/t-orbit/card-{width}.{format}?v=abc123",
    );
    expect(titles.get("t-orbit")?.preview?.url).toBe("/cdn/previews/v-pkg/preview.mp4");
    expect(titles.get("t-orbit")?.attribution?.license).toBe("CC-BY-4.0");
    expect(titles.get("t-glasshouse")?.images.card.template).toBe(
      "/cdn/img/titles/t-glasshouse/card-{width}.{format}",
    );
    expect(titles.get("t-glasshouse")?.images.card.thumbhash).toBeNull();
    expect(titles.get("t-tides")?.isPlayable).toBe(true);
    expect(titles.get("t-kestrel")).toMatchObject({
      seasonCount: 2,
      isPlayable: true,
      runtimeSec: null,
    });
    expect(
      write.episodes
        .filter((episode) => episode.titleId === "t-kestrel")
        .map((episode) => episode.seq),
    ).toEqual([1, 2, 3, 4, 5]);

    // Without a manifest everything plays through the external fallback where one exists.
    const bare = buildCatalogWrite(FIXTURE_CATALOG, null, TEST_NOW, "v");
    expect(bare.videoAssets.find((asset) => asset.id === "v-pkg")?.kind).toBe("external");
    expect(bare.titles.find((title) => title.id === "t-orbit")?.preview).toBeNull();

    // A seed without any external stream leaves unpackaged media unavailable.
    const silent = buildCatalogWrite(withoutStreams(), null, TEST_NOW, "v");
    expect(silent.videoAssets.every((asset) => asset.kind === "unavailable")).toBe(true);
    expect(silent.titles.every((title) => !title.isPlayable)).toBe(true);
  });

  it("lets a chapter fall back to its whole film's stream", () => {
    const film = "https://example.org/film.mp4";
    const license = {
      license: "CC0-1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution: "x",
      sourceUrl: null,
    };
    const catalog = {
      ...FIXTURE_CATALOG,
      videoAssets: [
        ...FIXTURE_CATALOG.videoAssets,
        {
          id: "v-film",
          label: "Film",
          source: { kind: "download" as const, url: film, sha256: null, license },
          externalHlsUrl: "https://streams.example.org/film.m3u8",
          subtitleLanguages: [],
        },
        {
          id: "v-chapter",
          label: "Chapter",
          source: {
            kind: "download" as const,
            url: film,
            sha256: null,
            license,
            startSec: 60,
            durationSec: 120,
          },
          externalHlsUrl: null,
          subtitleLanguages: [],
        },
      ],
    };
    const write = buildCatalogWrite(catalog, null, TEST_NOW, "v");
    expect(write.videoAssets.find((asset) => asset.id === "v-chapter")).toMatchObject({
      kind: "external",
      externalUrl: "https://streams.example.org/film.m3u8",
      durationSec: 120,
    });
  });

  it("is idempotent and re-applies on change or when forced", async () => {
    const repos = createMemoryRepositories();
    const t = await createTestServices({ repos });
    const hash = await repos.meta.get(SEED_HASH_KEY);
    const before = structuredClone(repos.store.titles);
    const again = await t.services.seeder.seed({
      catalog: FIXTURE_CATALOG,
      demoAccount: FIXTURE_DEMO_ACCOUNT,
      manifest: FIXTURE_MANIFEST,
    });
    expect(again.skipped).toBe(true);
    expect(repos.store.titles).toEqual(before);

    const forced = await t.services.seeder.seed(
      { catalog: FIXTURE_CATALOG, demoAccount: FIXTURE_DEMO_ACCOUNT, manifest: FIXTURE_MANIFEST },
      { force: true },
    );
    expect(forced).toMatchObject({
      skipped: false,
      titles: 22,
      episodes: 22,
      packagedAssets: 1,
      externalAssets: 2,
      unavailableAssets: 0,
    });
    expect(await repos.meta.get(SEED_HASH_KEY)).toBe(hash);
    expect(
      [...repos.store.accounts.values()].filter((account) => account.email === "demo@webflix.dev"),
    ).toHaveLength(1);
    expect(repos.store.profiles.size).toBe(3);

    const smaller = {
      ...FIXTURE_CATALOG,
      titles: FIXTURE_CATALOG.titles.filter((title) => title.id !== "t-cellar"),
    };
    const changed = await t.services.seeder.seed({
      catalog: smaller,
      demoAccount: null,
      manifest: null,
    });
    expect(changed.skipped).toBe(false);
    expect(repos.store.titles.map((title) => title.id)).not.toContain("t-cellar");
    const viewer = await demoViewer(t);
    const search = await t.services.search.search(viewer, { q: "cellar" });
    expect(search.results).toEqual([]);
  });

  it("indexes every title for search", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    for (const title of FIXTURE_CATALOG.titles) {
      const found = await t.services.search.search(viewer, { q: title.name });
      expect(
        found.results.map((card) => card.id),
        title.name,
      ).toContain(title.id);
    }
  });
});
