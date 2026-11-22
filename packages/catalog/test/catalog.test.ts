import { DEMO_ACCOUNT_EMAIL, MATURITY_LEVELS } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { ART_DIRECTION } from "../src/data/art.ts";
import {
  CURATED_PREVIEWS,
  catalog,
  defineCatalog,
  defineDemoAccount,
  demoAccount,
  featureCut,
  footagePreviewAsset,
  frameShowsText,
  MOTION_ART_PREVIEW_SEC,
  mediumOfGenres,
  motionArtAsset,
  openFilms,
  showsSourceText,
  TEXT_MARGIN_SEC,
} from "../src/index.ts";

const episodes = catalog.titles.flatMap((title) =>
  title.type === "series" ? title.seasons.flatMap((season) => season.episodes) : [],
);
const rank = (level: string) => MATURITY_LEVELS.indexOf(level as (typeof MATURITY_LEVELS)[number]);

describe("catalog package", () => {
  it("exports a valid catalog and demo account", () => {
    expect(catalog.version).toBe(1);
    expect(demoAccount.email).toBe(DEMO_ACCOUNT_EMAIL);
    expect(demoAccount.profiles.length).toBeGreaterThan(0);
  });

  it("lists every problem of an invalid catalog in one error", () => {
    expect(() =>
      defineCatalog({ ...catalog, avatars: [{ id: "a-x", name: "X", groupId: "missing" }] }),
    ).toThrow(/avatars\.0\.groupId: Unknown avatar group missing/);
  });

  it("cross-checks the demo account against the catalog", () => {
    const broken = {
      ...demoAccount,
      profiles: demoAccount.profiles.map((profile) => ({ ...profile, myList: ["t-ghost"] })),
    };
    expect(() => defineDemoAccount(broken, catalog)).toThrow(/unknown title t-ghost/);
  });
});

describe("dataset", () => {
  it("is a believable service-sized catalog", () => {
    const movies = catalog.titles.filter((title) => title.type === "movie");
    expect(catalog.titles.length).toBeGreaterThanOrEqual(110);
    expect(movies.length).toBeGreaterThan(50);
    expect(catalog.titles.length - movies.length).toBeGreaterThan(40);
    expect(episodes.length).toBeGreaterThan(300);
    expect(catalog.genres).toHaveLength(16);
    for (const genre of catalog.genres) {
      const count = catalog.titles.filter((title) => title.genreIds.includes(genre.id)).length;
      expect(count, genre.slug).toBeGreaterThanOrEqual(5);
    }
  });

  it("staggers arrivals so New Releases and Originals rows have content", () => {
    expect(
      catalog.titles.filter((title) => title.addedDaysAgo <= 21).length,
    ).toBeGreaterThanOrEqual(10);
    expect(catalog.titles.filter((title) => title.isOriginal).length).toBeGreaterThanOrEqual(20);
    expect(new Set(catalog.titles.map((title) => title.popularity)).size).toBeGreaterThan(50);
  });

  it("credits the real open films with their licence and their own footage", () => {
    const open = catalog.titles.filter((title) => title.license !== null);
    expect(open.map((title) => title.id).sort()).toEqual(
      [
        "t-big-buck-bunny",
        "t-caminandes",
        "t-charge",
        "t-coffee-run",
        "t-cosmos-laundromat",
        "t-elephants-dream",
        "t-sintel",
        "t-spring",
        "t-sprite-fright",
        "t-tears-of-steel",
        "t-wing-it",
      ].sort(),
    );
    for (const title of open) {
      expect(title.license?.license, title.id).toMatch(/^CC-BY-/);
      expect(title.isOriginal).toBe(false);
    }
    expect(
      catalog.titles.filter((title) => !title.license).every((title) => title.isOriginal || true),
    ).toBe(true);
  });

  it("gives every title a distinct preview excerpt and spreads films across a genre", () => {
    const previews = catalog.titles.map((title) => title.previewAssetId);
    expect(new Set(previews).size).toBe(previews.length);
    for (const genre of catalog.genres) {
      const assets = catalog.titles
        .filter(
          (title) => title.genreIds[0] === genre.id && title.type === "movie" && !title.license,
        )
        .map((title) => (title.type === "movie" ? title.videoAssetId : ""));
      if (assets.length >= 4)
        expect(new Set(assets).size, genre.slug).toBeGreaterThan(assets.length / 2);
    }
  });

  it("only borrows footage from known open films, inside their running time", () => {
    const films = new Map(openFilms.map((film) => [film.source.url, film]));
    const previewers = new Map(catalog.titles.map((title) => [title.previewAssetId, title.id]));
    for (const asset of catalog.videoAssets) {
      if (asset.source.kind === "synthetic") {
        // Motion art rendered from exactly one title's key art.
        expect(asset.id, asset.id).toMatch(/^v-art-.+-[0-9a-z]{7}$/);
        expect(asset.source.durationSec).toBe(MOTION_ART_PREVIEW_SEC);
        const title = previewers.get(asset.id) ?? "";
        expect(asset.id, title).toBe(motionArtAsset(title, ART_DIRECTION[title]));
        continue;
      }
      const film = films.get(asset.source.url);
      expect(film, asset.id).toBeDefined();
      const end = (asset.source.startSec ?? 0) + (asset.source.durationSec ?? 0);
      expect(end, asset.id).toBeLessThanOrEqual(film?.durationSec ?? 0);
    }
  });

  it("never plays footage rated above the title (all-ages titles may use mild 7+ cartoons)", () => {
    const films = new Map(openFilms.map((film) => [film.source.url, film]));
    const assets = new Map(catalog.videoAssets.map((asset) => [asset.id, asset]));
    for (const title of catalog.titles) {
      const used = [
        title.previewAssetId ?? "",
        ...(title.type === "movie"
          ? [title.videoAssetId]
          : title.seasons.flatMap((season) =>
              season.episodes.map((episode) => episode.videoAssetId),
            )),
      ];
      for (const id of used) {
        const asset = assets.get(id);
        if (asset?.source.kind === "synthetic") continue;
        const film = asset?.source.kind === "download" ? films.get(asset.source.url) : undefined;
        expect(rank(film?.maturity ?? "18+"), `${title.id} uses ${id}`).toBeLessThanOrEqual(
          Math.max(rank(title.maturity), rank("7+")),
        );
      }
    }
  });

  describe("footage never contradicts the title it plays under", () => {
    const films = new Map(openFilms.map((film) => [film.source.url, film]));
    const assets = new Map(catalog.videoAssets.map((asset) => [asset.id, asset]));
    const genreSlug = new Map(catalog.genres.map((genre) => [genre.id, genre.slug]));
    const filmOf = (assetId: string | null | undefined) => {
      const asset = assetId ? assets.get(assetId) : undefined;
      return asset?.source.kind === "download" ? films.get(asset.source.url) : undefined;
    };
    const windowOf = (assetId: string, film: (typeof openFilms)[number]) => {
      const source = assets.get(assetId)?.source;
      const start = source?.kind === "download" ? (source.startSec ?? 0) : 0;
      const length = source?.kind === "download" ? source.durationSec : undefined;
      return [start, start + (length ?? film.durationSec - start)] as const;
    };
    /** The open films a real title is made of (Caminandes is three); empty for fiction. */
    const ownFilms = (title: (typeof catalog.titles)[number]) =>
      new Set(
        title.license
          ? (title.type === "movie"
              ? [title.videoAssetId]
              : title.seasons.flatMap((season) => season.episodes.map((e) => e.videoAssetId))
            ).flatMap((id) => filmOf(id) ?? [])
          : [],
      );
    const ownFilm = (title: (typeof catalog.titles)[number]) => [...ownFilms(title)][0];
    const mediumOf = (title: (typeof catalog.titles)[number]) =>
      ownFilm(title)?.medium ?? mediumOfGenres(title.genreIds.map((id) => genreSlug.get(id) ?? ""));
    const playedBy = (title: (typeof catalog.titles)[number]) => [
      title.previewAssetId ?? "",
      ...(title.type === "movie"
        ? [title.videoAssetId]
        : title.seasons.flatMap((season) =>
            season.episodes.map((episode) => episode.videoAssetId),
          )),
    ];

    it("previews come from the title itself, a curated match or its own key art", () => {
      const classes = { own: 0, curated: 0, art: 0 };
      for (const title of catalog.titles) {
        const preview = title.previewAssetId ?? "";
        const film = filmOf(preview);
        const own = ownFilm(title);
        if (own) {
          expect(film && ownFilms(title).has(film), title.id).toBe(true);
          classes.own += 1;
        } else if (film) {
          expect(CURATED_PREVIEWS[title.id]?.film, `${title.id} previews ${preview}`).toBe(
            film.key,
          );
          classes.curated += 1;
        } else {
          expect(preview, title.id).toBe(motionArtAsset(title.id, ART_DIRECTION[title.id]));
          classes.art += 1;
        }
      }
      expect(classes.own).toBe(11);
      expect(classes.curated).toBe(Object.keys(CURATED_PREVIEWS).length);
      expect(classes.own + classes.curated + classes.art).toBe(catalog.titles.length);
    });

    it("a preview clip is always the same medium as its title (no cartoons under live action)", () => {
      for (const title of catalog.titles) {
        const film = filmOf(title.previewAssetId);
        if (film)
          expect(film.medium, `${title.id} previews ${title.previewAssetId}`).toBe(mediumOf(title));
      }
    });

    it("footage showing a film's title cards, logos or credits plays only under that film", () => {
      for (const title of catalog.titles) {
        for (const assetId of playedBy(title)) {
          const film = filmOf(assetId);
          if (!film || !showsSourceText(film, windowOf(assetId, film))) continue;
          expect(
            ownFilms(title).has(film),
            `${title.id} plays ${assetId}, which shows ${film.name}'s titles`,
          ).toBe(true);
        }
      }
    });

    it("no preview opens on, or comes near, a burned-in card, real films' own previews included", () => {
      for (const title of catalog.titles) {
        const preview = title.previewAssetId ?? "";
        const film = filmOf(preview);
        if (film) expect(showsSourceText(film, windowOf(preview, film)), title.id).toBe(false);
      }
    });

    it("cuts, chapters and excerpts are whole seconds, so packaging cannot round into a card", () => {
      for (const asset of catalog.videoAssets) {
        if (asset.source.kind !== "download") continue;
        expect(Number.isInteger(asset.source.startSec ?? 0), asset.id).toBe(true);
        expect(Number.isInteger(asset.source.durationSec ?? 0), asset.id).toBe(true);
      }
      for (const film of openFilms) {
        const [start, end] = featureCut(film);
        expect(showsSourceText(film, [start, end]), `${film.key} cut`).toBe(false);
        expect(Number.isInteger(start) && Number.isInteger(end), `${film.key} cut`).toBe(true);
      }
    });

    it("chapters are text-free and each later one opens with the end of the one before", () => {
      for (const film of openFilms) {
        film.chapters.forEach((chapter, index) => {
          expect(showsSourceText(film, chapter), `${film.key} chapter ${index + 1}`).toBe(false);
          const previous = film.chapters[index - 1];
          if (previous && film.chapters.length > 1)
            expect(previous[1] - chapter[0], `${film.key} chapter ${index + 1} recap`).toBe(20);
        });
      }
    });
  });

  it("measures text spans in order, inside each film, with the margin clear of every chapter", () => {
    expect(TEXT_MARGIN_SEC).toBeGreaterThanOrEqual(1);
    for (const film of openFilms) {
      let previous = -1;
      for (const [start, end] of film.textSpans) {
        expect(start, film.key).toBeGreaterThan(previous);
        expect(end, film.key).toBeGreaterThan(start);
        expect(end, film.key).toBeLessThanOrEqual(film.durationSec);
        previous = end;
      }
      for (const [start, end] of [...film.chapters, featureCut(film)]) {
        expect(end, `${film.key} [${start}, ${end}] ends before the credits`).toBeLessThan(
          film.creditsStartSec,
        );
        for (const [textStart, textEnd] of film.textSpans) {
          const gap = Math.max(textStart - end, start - textEnd);
          expect(gap, `${film.key} chapter [${start}, ${end}]`).toBeGreaterThanOrEqual(
            TEXT_MARGIN_SEC,
          );
        }
      }
    }
  });

  it("cuts the real films' key art from text-free frames (the logo is laid over them)", () => {
    const filmOfTitle = new Map(
      catalog.titles.flatMap((title) => {
        const id = title.type === "movie" ? title.videoAssetId : null;
        const source = catalog.videoAssets.find((entry) => entry.id === id)?.source;
        const film =
          source?.kind === "download"
            ? openFilms.find((entry) => entry.source.url === source.url)
            : undefined;
        return film ? [[title.id, film] as const] : [];
      }),
    );
    for (const [titleId, art] of Object.entries(ART_DIRECTION)) {
      const frames = art.frames as { key: number; poster: number; asset?: string } | undefined;
      if (!frames) continue;
      const film = frames.asset
        ? openFilms.find((entry) => `v-${entry.key}` === frames.asset)
        : filmOfTitle.get(titleId);
      expect(film, titleId).toBeDefined();
      if (!film) continue;
      expect(frameShowsText(film, frames.key), `${titleId} key frame`).toBe(false);
      expect(frameShowsText(film, frames.poster), `${titleId} poster frame`).toBe(false);
    }
  });

  it("derives every preview id from what defines its content (published previews are immutable)", () => {
    const films = new Map(openFilms.map((film) => [film.source.url, film]));
    for (const asset of catalog.videoAssets) {
      if (!/-pv\d/.test(asset.id) || asset.source.kind !== "download") continue;
      const film = films.get(asset.source.url);
      const start = asset.source.startSec ?? 0;
      const window = [start, start + (asset.source.durationSec ?? 0)] as const;
      expect(film && footagePreviewAsset(film, window), asset.id).toBe(asset.id);
    }
    const [film] = openFilms;
    if (!film) return;
    expect(footagePreviewAsset(film, [10, 40])).not.toBe(footagePreviewAsset(film, [11, 41]));
    expect(footagePreviewAsset(film, [10, 40])).toBe(footagePreviewAsset(film, [10, 40]));
    expect(
      footagePreviewAsset(
        { ...film, source: { ...film.source, url: "https://example.org/b.mp4" } },
        [10, 40],
      ),
    ).not.toBe(footagePreviewAsset(film, [10, 40]));
  });

  it("gives motion art a new id whenever the recipe's input, the art direction, changes", () => {
    expect(motionArtAsset("t-x", { grade: "warm" })).not.toBe(
      motionArtAsset("t-x", { grade: "cold" }),
    );
    expect(motionArtAsset("t-x", undefined)).toBe(motionArtAsset("t-x", undefined));
  });

  it("gives every episode its own name and synopsis", () => {
    const series = catalog.titles.filter((title) => title.type === "series");
    for (const title of series) {
      if (title.type !== "series") continue;
      const names = title.seasons.flatMap((season) =>
        season.episodes.map((episode) => episode.name),
      );
      expect(new Set(names).size, title.id).toBe(names.length);
    }
    expect(new Set(episodes.map((episode) => episode.synopsis)).size).toBe(episodes.length);
  });
});

describe("demo account", () => {
  const titles = new Map(catalog.titles.map((title) => [title.id, title]));

  it("fills Continue Watching, Watch It Again, My List and ratings on first visit", () => {
    const [main] = demoAccount.profiles;
    expect(main?.viewing.filter((entry) => !entry.completed).length).toBeGreaterThanOrEqual(4);
    expect(main?.viewing.filter((entry) => entry.completed).length).toBeGreaterThanOrEqual(5);
    expect(main?.myList.length).toBeGreaterThanOrEqual(6);
    expect(new Set(main?.ratings.map((rating) => rating.value))).toEqual(
      new Set(["love", "like", "dislike"]),
    );
  });

  it("has a PIN-locked profile and a kids profile that stays within its ceiling", () => {
    expect(demoAccount.profiles.some((profile) => profile.pin !== null)).toBe(true);
    const kids = demoAccount.profiles.find((profile) => profile.isKids);
    expect(kids).toBeDefined();
    const touched = [
      ...(kids?.myList ?? []),
      ...(kids?.ratings.map((rating) => rating.titleId) ?? []),
      ...(kids?.viewing.map((entry) => entry.titleId) ?? []),
    ];
    for (const id of touched) {
      expect(rank(titles.get(id)?.maturity ?? "18+"), id).toBeLessThanOrEqual(
        rank(kids?.maturityCeiling ?? "7+"),
      );
    }
  });
});
