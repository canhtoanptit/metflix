import { describe, expect, it } from "vitest";
import type { SearchDocument, SearchIndex, SearchQuery } from "../ports/search-index.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

export interface SearchIndexHarness extends HarnessBase {
  /** An empty index. */
  index: SearchIndex;
}

/** The corpus every adapter is tested against. */
export const SEARCH_CONTRACT_CORPUS: readonly SearchDocument[] = [
  {
    id: "t-ember",
    type: "movie",
    maturity: "13+",
    name: "Ember of the North",
    people: [{ id: "p-halina", name: "Halina Reyes" }],
    genres: [
      { slug: "fantasy", name: "Fantasy" },
      { slug: "animation", name: "Animation" },
    ],
    moods: ["Epic"],
    synopsis: "A lonely young woman searches the frozen north for her lost baby dragon.",
    popularity: 90,
  },
  {
    id: "t-dragon-king",
    type: "movie",
    maturity: "7+",
    name: "The Dragon King",
    people: [{ id: "p-otto", name: "Otto Brandt" }],
    genres: [{ slug: "family", name: "Family" }],
    moods: ["Whimsical"],
    synopsis: "A boy befriends a crown that talks.",
    popularity: 10,
  },
  {
    id: "t-amelie",
    type: "movie",
    maturity: "ALL",
    name: "Amélie's Garden",
    people: [{ id: "p-noe", name: "Noé Lefèvre" }],
    genres: [{ slug: "comedy", name: "Comedy" }],
    moods: ["Heartfelt"],
    synopsis: "A gardener in Montmartre plants a secret in every window box.",
    popularity: 50,
  },
  {
    id: "t-kestrel",
    type: "series",
    maturity: "16+",
    name: "Night Shift at Kestrel Bay",
    people: [{ id: "p-mara", name: "Mara Okonkwo" }],
    genres: [{ slug: "thriller", name: "Thriller" }],
    moods: ["Suspenseful"],
    synopsis: "A harbour town hides what washes up after midnight.",
    popularity: 70,
  },
  {
    id: "t-black-lake",
    type: "movie",
    maturity: "18+",
    name: "Black Lake",
    people: [
      { id: "p-mara", name: "Mara Okonkwo" },
      { id: "p-ivo", name: "Ivo Sandström" },
    ],
    genres: [{ slug: "horror", name: "Horror" }],
    moods: ["Dark"],
    synopsis: "Nobody swims at night.",
    popularity: 60,
  },
];

/** Contract every `SearchIndex` adapter must pass. */
export function describeSearchIndexContract(
  name: string,
  factory: HarnessFactory<SearchIndexHarness>,
): void {
  describe(`SearchIndex contract: ${name}`, () => {
    const h = useHarness(async () => {
      const harness = await factory();
      await harness.index.upsert(SEARCH_CONTRACT_CORPUS);
      return harness;
    });
    const search = (text: string, overrides: Partial<SearchQuery> = {}) =>
      h().index.search({ text, maturityCeiling: "18+", limit: 20, ...overrides });
    const ids = async (text: string, overrides: Partial<SearchQuery> = {}) =>
      (await search(text, overrides)).hits.map((hit) => hit.id);

    it("finds titles by a word of the name and by prefix", async () => {
      expect(await ids("ember")).toEqual(["t-ember"]);
      expect(await ids("emb")).toEqual(["t-ember"]);
      expect(await ids("kestr")).toEqual(["t-kestrel"]);
    });

    it("is case- and diacritic-insensitive", async () => {
      expect(await ids("AMELIE")).toEqual(["t-amelie"]);
      expect(await ids("sandstrom")).toEqual(["t-black-lake"]);
      expect(await ids("Noé")).toEqual(["t-amelie"]);
    });

    it("requires every query token to match", async () => {
      expect(await ids("night bay")).toEqual(["t-kestrel"]);
      expect(await ids("night ember")).toEqual([]);
    });

    it("finds titles by person, genre and mood", async () => {
      expect((await ids("okonkwo")).sort()).toEqual(["t-black-lake", "t-kestrel"]);
      expect(await ids("thriller")).toEqual(["t-kestrel"]);
      expect(await ids("whimsical")).toEqual(["t-dragon-king"]);
    });

    it("ranks a name match above a synopsis-only match regardless of popularity", async () => {
      const result = await search("dragon");
      expect(result.hits.map((hit) => hit.id)).toEqual(["t-dragon-king", "t-ember"]);
      expect(result.hits[0]?.matchedFields).toContain("name");
      expect(result.hits[1]?.matchedFields).toEqual(["synopsis"]);
    });

    it("filters by maturity ceiling inside the index", async () => {
      expect((await ids("okonkwo", { maturityCeiling: "16+" })).sort()).toEqual(["t-kestrel"]);
      expect(await ids("dragon", { maturityCeiling: "7+" })).toEqual(["t-dragon-king"]);
      expect(await ids("okonkwo", { maturityCeiling: "13+" })).toEqual([]);
    });

    it("filters by type", async () => {
      expect(await ids("okonkwo", { type: "series" })).toEqual(["t-kestrel"]);
    });

    it("pages through results without gaps or duplicates", async () => {
      const full = await ids("a");
      expect(full.length).toBeGreaterThanOrEqual(3);
      const paged: string[] = [];
      let cursor: string | null = null;
      for (let pages = 0; pages < 10; pages += 1) {
        const page = await search("a", { limit: 2, cursor });
        expect(page.hits.length).toBeLessThanOrEqual(2);
        paged.push(...page.hits.map((hit) => hit.id));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(paged).toEqual(full);
    });

    it("refuses a cursor it did not issue (validation_failed), never restarting at page one", async () => {
      for (const cursor of ["not-a-cursor", "eyJ4IjoxfQ", "eyJvIjotMX0"]) {
        await expect(search("a", { cursor })).rejects.toMatchObject({
          code: "validation_failed",
        });
      }
    });

    it("suggests and searches with long queries in any script", async () => {
      const { index } = h();
      const long = {
        cjk: "東京湾岸警備隊東京湾岸警備隊東京湾岸警備隊",
        cyrillic: "Достопримечательностидостопримечательности",
        astral: "𠀀𠀁𠀂𠀃𠀄𠀅𠀆𠀇𠀈𠀉𠀊𠀋𠀌𠀍",
      };
      await index.upsert(
        Object.entries(long).map(([script, name], position) => ({
          id: `t-long-${script}`,
          type: "movie" as const,
          maturity: "ALL" as const,
          name,
          people: [],
          genres: [],
          moods: [],
          synopsis: "",
          popularity: 30 + position,
        })),
      );
      for (const [script, name] of Object.entries(long)) {
        const titles = await index.suggest({ text: name, maturityCeiling: "18+", limit: 5 });
        expect(titles, script).toContainEqual({
          kind: "title",
          id: `t-long-${script}`,
          label: name,
        });
        expect(await ids(name), script).toEqual([`t-long-${script}`]);
      }
      // Emoji are not words; combining marks fold away like accents.
      expect(
        await index.suggest({
          text: "🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉",
          maturityCeiling: "18+",
          limit: 5,
        }),
      ).toEqual([]);
      const combining = "Ame\u0301lie's Garden".repeat(4);
      expect(await index.suggest({ text: combining, maturityCeiling: "18+", limit: 5 })).toEqual(
        [],
      );
      expect(
        await index.suggest({ text: "Ame\u0301lie\u0301\u0301", maturityCeiling: "18+", limit: 5 }),
      ).toContainEqual({ kind: "title", id: "t-amelie", label: "Amélie's Garden" });
    });

    it("returns nothing for an empty query", async () => {
      expect((await search("   ")).hits).toEqual([]);
      expect((await search("!!")).hits).toEqual([]);
    });

    it("replaces documents on upsert and forgets removed ones", async () => {
      const { index } = h();
      const [ember] = SEARCH_CONTRACT_CORPUS;
      if (!ember) throw new Error("corpus");
      await index.upsert([{ ...ember, name: "Cinder of the South" }]);
      expect(await ids("ember")).toEqual([]);
      expect(await ids("cinder")).toEqual(["t-ember"]);
      await index.remove(["t-ember", "t-unknown"]);
      expect(await ids("cinder")).toEqual([]);
    });

    it("suggests titles, people and genres visible under the ceiling", async () => {
      const { index } = h();
      const all = await index.suggest({ text: "mar", maturityCeiling: "18+", limit: 10 });
      expect(all).toContainEqual({ kind: "person", id: "p-mara", label: "Mara Okonkwo" });

      const kids = await index.suggest({ text: "mar", maturityCeiling: "13+", limit: 10 });
      expect(kids.find((hit) => hit.id === "p-mara")).toBeUndefined();

      const genres = await index.suggest({ text: "fant", maturityCeiling: "18+", limit: 10 });
      expect(genres).toContainEqual({ kind: "genre", id: "fantasy", label: "Fantasy" });

      const titles = await index.suggest({ text: "black", maturityCeiling: "18+", limit: 10 });
      expect(titles).toContainEqual({ kind: "title", id: "t-black-lake", label: "Black Lake" });

      const limited = await index.suggest({ text: "a", maturityCeiling: "18+", limit: 2 });
      expect(limited.length).toBeLessThanOrEqual(2);
    });
  });
}
