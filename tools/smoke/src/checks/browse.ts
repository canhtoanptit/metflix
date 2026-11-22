import {
  BADGES_PER_LIST,
  BROWSE_VIEWS,
  GENRE_SORTS,
  type GenreSort,
  nominalVideoHeight,
  type Row,
  SEARCH_QUERY_INPUT_MAX_LENGTH,
  SEARCH_QUERY_MAX_LENGTH,
  SHOWCASE_MATURITY_CEILING,
  SHOWCASE_SIZE,
  Showcase,
  type TitleCard,
  TOP_10_BADGES_PER_LIST,
  VIDEO_QUALITY_TIERS,
  videoQualityForHeight,
} from "@webflix/contracts";
import { check, equal, fail, header, problem, rejects, succeeds } from "../expect.ts";
import type { Agent } from "../http.ts";
import { needs } from "../needs.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { watch } from "./library.ts";
import {
  API,
  accentFirstVowel,
  browseAll,
  cardsOfRow,
  maturityRank,
  stripDiacritics,
  unique,
} from "./util.ts";

const VIEW_TYPE = { home: null, series: "series", movies: "movie", "new-popular": null } as const;

async function genreListing(
  agent: Agent,
  slug: string,
  sort: GenreSort,
  type?: "movie" | "series",
): Promise<TitleCard[]> {
  const items: TitleCard[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await succeeds(
      () =>
        agent.api.getGenreBrowse({
          params: { slug },
          query: { sort, limit: 100, ...(type ? { type } : {}), ...(cursor ? { cursor } : {}) },
        }),
      `genre ${slug} sort=${sort}`,
    );
    equal(result.sort, sort, `genre page sort echo (${sort})`);
    equal(result.type, type ?? null, "genre page type echo");
    items.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

const collator = new Intl.Collator("en", { sensitivity: "base" });

export const browseChecks: CheckDefinition[] = [
  {
    id: "browse.views",
    area: "browse",
    title: "Every view returns a billboard (except New & Popular) and typed, non-empty rows",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      for (const view of BROWSE_VIEWS) {
        const page = await succeeds(
          () => viewer.agent.api.getBrowse({ query: { view } }),
          `GET /browse?view=${view}`,
        );
        equal(page.view, view, "view echo");
        if (view === "new-popular") equal(page.billboard, null, "new-popular billboard");
        else check(page.billboard, `${view} has no billboard`);
        check(page.rows.length > 0, `${view} has no rows`);
        const ids = page.rows.map((row) => row.id);
        check(new Set(ids).size === ids.length, `${view} repeats a row id`, {
          observed: ids.join(", "),
        });
        const type = VIEW_TYPE[view];
        for (const row of page.rows) {
          const cards = cardsOfRow(row);
          check(cards.length > 0, `row ${row.id} is empty`);
          check(row.items.length <= 20, `row ${row.id} arrived with more than 20 items`, {
            observed: String(row.items.length),
          });
          if (type) {
            const wrong = cards.filter((card) => card.type !== type);
            check(
              wrong.length === 0,
              `${view} row ${row.id} shows ${wrong[0]?.type ?? ""} titles`,
              {
                observed: wrong.map((card) => card.id).join(", "),
              },
            );
          }
          if (row.layout === "ranked") {
            equal(
              row.items.map((item) => item.rank).join(","),
              row.items.map((_, index) => index + 1).join(","),
              `ranks of ${row.id}`,
            );
          }
        }
        if (type && page.billboard)
          equal(page.billboard.title.type, type, `${view} billboard type`);
      }
    },
  },
  {
    id: "browse.row-batches",
    area: "browse",
    title: "Row batches follow nextCursor without repeating rows; tampered cursors are rejected",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      const { pages, rows } = await browseAll(viewer.agent, "home");
      const ids = rows.map((row) => row.id);
      check(new Set(ids).size === ids.length, "a row appears in two batches", {
        observed: ids.join(", "),
      });
      for (const [index, page] of pages.entries()) {
        check(page.rows.length <= 6, `batch ${index + 1} has more than 6 rows`, {
          observed: String(page.rows.length),
        });
        if (index > 0) equal(page.billboard, null, `billboard on batch ${index + 1}`);
      }
      ctx.note(`home: ${rows.length} rows in ${pages.length} batches`);
      const tampered = await viewer.agent.fetch(
        `${API}/browse?view=home&cursor=smoke-not-a-cursor`,
      );
      problem(tampered, "validation_failed", "tampered browse cursor");
    },
  },
  {
    id: "browse.row-pagination",
    area: "browse",
    title: "A row's next pages continue it without overlap; limit, unknown rows and bad cursors",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      const { rows } = await browseAll(viewer.agent, "home");
      const row = rows.find(
        (candidate) => candidate.nextCursor !== null && candidate.layout !== "ranked",
      );
      if (!row) ctx.skip("no home row has a second page for this profile");
      const seen = new Set(cardsOfRow(row).map((card) => card.id));
      let cursor = row.nextCursor;
      let pages = 1;
      while (cursor && pages < 10) {
        const current = cursor;
        const next: Row = await succeeds(
          () =>
            viewer.agent.api.getBrowseRow({
              params: { rowId: row.id },
              query: { cursor: current },
            }),
          `GET /browse/rows/${row.id} page ${pages + 1}`,
        );
        equal(next.id, row.id, "row id");
        equal(next.layout, row.layout, "row layout");
        for (const card of cardsOfRow(next)) {
          check(!seen.has(card.id), `row ${row.id} repeats ${card.id} on page ${pages + 1}`);
          seen.add(card.id);
        }
        cursor = next.nextCursor;
        pages += 1;
      }
      ctx.note(`${row.id}: ${seen.size} items over ${pages} pages`);
      const limited = await succeeds(
        () => viewer.agent.api.getBrowseRow({ params: { rowId: row.id }, query: { limit: 5 } }),
        "row with limit=5",
      );
      check(limited.items.length <= 5 && limited.nextCursor !== null, "limit=5 is not honoured", {
        observed: `${limited.items.length} items, nextCursor ${limited.nextCursor}`,
      });
      await rejects(
        () => viewer.agent.api.getBrowseRow({ params: { rowId: `home:genre:${unique("smoke")}` } }),
        "not_found",
        "unknown row id",
      );
      problem(
        await viewer.agent.fetch(
          `${API}/browse/rows/${encodeURIComponent(row.id)}?cursor=smoke-not-a-cursor`,
        ),
        "validation_failed",
        "tampered row cursor",
      );
    },
  },
  {
    id: "browse.genres",
    area: "browse",
    title: "Genre pages: every sort orders correctly, type filter, pagination, unknown genre",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      const { genres, cards } = await ctx.env.catalog();
      check(genres.length > 0, "GET /genres is empty");
      const sizes = genres.map((genre) => ({
        genre,
        count: cards.filter((card) => card.genres.some((ref) => ref.slug === genre.slug)).length,
      }));
      const genre = [...sizes].sort((a, b) => b.count - a.count)[0]?.genre;
      check(genre, "no genre to browse");
      const listings = new Map<GenreSort, TitleCard[]>();
      for (const sort of GENRE_SORTS)
        listings.set(sort, await genreListing(viewer.agent, genre.slug, sort));
      const az = listings.get("a-z") ?? [];
      check(az.length > 1, `genre ${genre.slug} has fewer than two titles`);
      const ids = (list: TitleCard[]) => list.map((card) => card.id);
      for (const [sort, list] of listings) {
        equal(
          ids(list).sort().join(","),
          ids(az).sort().join(","),
          `titles of sort ${sort} (same set as a-z)`,
        );
      }
      for (let index = 1; index < az.length; index += 1) {
        const previous = az[index - 1];
        const current = az[index];
        if (previous && current && collator.compare(previous.name, current.name) > 0) {
          fail(`a-z is out of order at position ${index}`, {
            observed: `"${previous.name}" before "${current.name}"`,
          });
        }
      }
      equal(
        ids(listings.get("z-a") ?? []).join(","),
        ids(az).reverse().join(","),
        "z-a is a-z reversed",
      );
      const years = (sort: GenreSort) => (listings.get(sort) ?? []).map((card) => card.releaseYear);
      const newest = years("newest");
      check(
        newest.every((year, index) => index === 0 || year <= (newest[index - 1] ?? year)),
        "newest is not by release year, descending",
        {
          observed: newest.join(","),
        },
      );
      const oldest = years("oldest");
      check(
        oldest.every((year, index) => index === 0 || year >= (oldest[index - 1] ?? year)),
        "oldest is not by release year, ascending",
        {
          observed: oldest.join(","),
        },
      );
      for (const type of ["movie", "series"] as const) {
        const typed = await genreListing(viewer.agent, genre.slug, "a-z", type);
        check(
          typed.every((card) => card.type === type),
          `type=${type} returns other types`,
        );
      }
      const first = await succeeds(
        () =>
          viewer.agent.api.getGenreBrowse({
            params: { slug: genre.slug },
            query: { sort: "a-z", limit: 1 },
          }),
        "limit=1",
      );
      check(first.items.length === 1 && first.nextCursor, "limit=1 did not paginate", {
        observed: JSON.stringify(first).slice(0, 200),
      });
      const second = await succeeds(
        () =>
          viewer.agent.api.getGenreBrowse({
            params: { slug: genre.slug },
            query: { sort: "a-z", limit: 1, cursor: first.nextCursor ?? "" },
          }),
        "page 2",
      );
      equal(second.items[0]?.id, az[1]?.id, "second page continues the a-z order");
      await rejects(
        () => viewer.agent.api.getGenreBrowse({ params: { slug: unique("smoke") } }),
        "not_found",
        "unknown genre",
      );
      problem(
        await viewer.agent.fetch(`${API}/browse/genre/Not%20A%20Slug`),
        "validation_failed",
        "invalid slug",
      );
      ctx.note(`genre ${genre.slug}: ${az.length} titles`);
    },
  },
  {
    id: "browse.title-detail",
    area: "browse",
    title: "Title detail for a movie and a series, with fresh viewer state",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      const { cards } = await ctx.env.catalog();
      for (const type of ["movie", "series"] as const) {
        const card = cards.find((candidate) => candidate.type === type);
        if (!card) {
          ctx.note(`no ${type} in the catalog`);
          continue;
        }
        const detail = await succeeds(
          () => viewer.agent.api.getTitle({ params: { id: card.id } }),
          `GET /titles/${card.id}`,
        );
        equal(detail.id, card.id, "detail id");
        equal(detail.type, type, "detail type");
        equal(detail.name, card.name, "detail name");
        equal(detail.maturity, card.maturity, "detail maturity");
        if (type === "series") check(detail.seasons.length > 0, `series ${card.id} has no seasons`);
        else equal(detail.seasons.length, 0, `movie ${card.id} seasons`);
        if (detail.isPlayable)
          check(detail.playTarget, `${card.id} is playable but has no play target`);
        equal(detail.viewer.inMyList, false, "viewer.inMyList on a fresh profile");
        equal(detail.viewer.rating, null, "viewer.rating on a fresh profile");
      }
    },
  },
  {
    id: "browse.episodes",
    area: "browse",
    title: "Episodes of a season are numbered and complete; bad seasons are not found",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      const { cards } = await ctx.env.catalog();
      const series = cards.find((card) => card.type === "series");
      const movie = cards.find((card) => card.type === "movie");
      if (!series) ctx.skip("the catalog has no series");
      const detail = await succeeds(
        () => viewer.agent.api.getTitle({ params: { id: series.id } }),
        "series detail",
      );
      for (const season of detail.seasons) {
        const episodes = await succeeds(
          () =>
            viewer.agent.api.listEpisodes({
              params: { id: series.id, seasonNumber: season.number },
            }),
          `season ${season.number}`,
        );
        equal(episodes.titleId, series.id, "episodes titleId");
        equal(episodes.season.number, season.number, "season number");
        equal(
          episodes.items.length,
          season.episodeCount,
          `episode count of season ${season.number}`,
        );
        equal(
          episodes.items.map((episode) => `${episode.seasonNumber}x${episode.number}`).join(","),
          episodes.items.map((_, index) => `${season.number}x${index + 1}`).join(","),
          `episode numbering of season ${season.number}`,
        );
      }
      await rejects(
        () => viewer.agent.api.listEpisodes({ params: { id: series.id, seasonNumber: 99 } }),
        "not_found",
        "season 99",
      );
      if (movie) {
        await rejects(
          () => viewer.agent.api.listEpisodes({ params: { id: movie.id, seasonNumber: 1 } }),
          "not_found",
          "episodes of a movie",
        );
      }
    },
  },
  {
    id: "browse.similar",
    area: "browse",
    title: "More Like This excludes the title itself",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      const { cards } = await ctx.env.catalog();
      const card = cards[0];
      check(card, "empty catalog");
      const similar = await succeeds(
        () => viewer.agent.api.listSimilar({ params: { id: card.id } }),
        "GET /titles/:id/similar",
      );
      check(similar.items.length > 0, `no similar titles for ${card.id}`);
      check(
        !similar.items.some((item) => item.id === card.id),
        "More Like This contains the title itself",
      );
      const ids = similar.items.map((item) => item.id);
      check(new Set(ids).size === ids.length, "More Like This repeats a title");
    },
  },
  {
    id: "browse.search",
    area: "browse",
    title: "Search: prefixes, case and diacritics, people, genres, empty results, validation",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      const { cards, genres } = await ctx.env.catalog();
      const search = (q: string) =>
        succeeds(() => viewer.agent.api.search({ query: { q, limit: 100 } }), `search "${q}"`);
      const word = (card: TitleCard) =>
        card.name
          .split(/\s+/)
          .find((token) => /^[A-Za-z]{5,}$/.test(token) && !/^(the|and|with)$/i.test(token));
      const target = cards.find((card) => word(card));
      check(target, "no title with a 5+ letter word to search for");
      const token = word(target) ?? "";
      const prefix = token.slice(0, 4).toLowerCase();
      const byPrefix = await search(prefix);
      check(
        byPrefix.results.some((card) => card.id === target.id),
        `prefix "${prefix}" does not find "${target.name}"`,
        {
          observed: byPrefix.results
            .slice(0, 10)
            .map((card) => card.name)
            .join(" | "),
        },
      );
      const exact = await search(target.name.toUpperCase());
      check(
        exact.results.slice(0, 3).some((card) => card.id === target.id),
        `the full name in upper case does not rank "${target.name}" in the top 3`,
        {
          observed: exact.results
            .slice(0, 5)
            .map((card) => card.name)
            .join(" | "),
        },
      );
      const accented = accentFirstVowel(target.name);
      if (accented) {
        const result = await search(accented);
        check(
          result.results.some((card) => card.id === target.id),
          `diacritics: "${accented}" does not find "${target.name}"`,
        );
      }
      const native = cards.find((card) => stripDiacritics(card.name) !== card.name);
      if (native) {
        const plain = stripDiacritics(native.name);
        const result = await search(plain);
        check(
          result.results.some((card) => card.id === native.id),
          `diacritics: "${plain}" does not find "${native.name}"`,
        );
      } else {
        ctx.note("no title name carries diacritics; checked accent-insensitive queries only");
      }
      // People: a cast member's name finds their title and is suggested as a person.
      let person: { id: string; name: string; titleId: string } | null = null;
      for (const card of cards.slice(0, 15)) {
        const detail = await succeeds(
          () => viewer.agent.api.getTitle({ params: { id: card.id } }),
          `detail ${card.id}`,
        );
        const member = detail.cast[0] ?? detail.directors[0];
        if (member) {
          person = { id: member.id, name: member.name, titleId: card.id };
          break;
        }
      }
      if (person) {
        const result = await search(person.name);
        check(
          result.results.some((card) => card.id === person.titleId),
          `searching person "${person.name}" does not find their title`,
        );
        check(
          result.suggestions.some(
            (suggestion) => suggestion.kind === "person" && suggestion.id === person.id,
          ),
          `"${person.name}" is not suggested as a person`,
          { observed: JSON.stringify(result.suggestions) },
        );
      } else {
        ctx.note("no credits found on the first titles; people search not exercised");
      }
      const genre = genres[0];
      if (genre) {
        const result = await search(genre.name);
        check(
          result.suggestions.some(
            (suggestion) => suggestion.kind === "genre" && suggestion.slug === genre.slug,
          ),
          `genre "${genre.name}" is not suggested`,
          { observed: JSON.stringify(result.suggestions) },
        );
      }
      const nothing = await search("zzqxv smokeless qwxz");
      equal(nothing.results.length, 0, "results for gibberish");
      equal(nothing.suggestions.length, 0, "suggestions for gibberish");
      equal(nothing.nextCursor, null, "nextCursor for gibberish");
      // A long query is searched in its first characters (never an error); only what no
      // search field sends is refused.
      const long = await succeeds(
        () => viewer.agent.api.search({ query: { q: `${"a".repeat(150)}` } }),
        "a 150-character query",
      );
      check(long.query.length <= SEARCH_QUERY_MAX_LENGTH, "the searched query was not cut", {
        observed: `${long.query.length} characters`,
      });
      problem(
        await viewer.agent.fetch(
          `${API}/search?q=${"a".repeat(SEARCH_QUERY_INPUT_MAX_LENGTH + 1)}`,
        ),
        "validation_failed",
        `a ${SEARCH_QUERY_INPUT_MAX_LENGTH + 1}-character query`,
      );
      problem(
        await viewer.agent.fetch(`${API}/search?q=%20%20`),
        "validation_failed",
        "blank query",
      );
    },
  },
  {
    id: "browse.demo-first-load",
    area: "browse",
    title: "Demo profile's first load is rich: billboard, a dozen varied rows, a full Top 10",
    tags: ["demo"],
    needs: [needs.demo],
    async run(ctx: CheckContext) {
      const demo = await ctx.env.demo();
      const agent = demo.viewer?.agent;
      check(agent, "demo viewer unavailable");
      const { pages, rows } = await browseAll(agent, "home");
      const first = pages[0];
      check(first?.billboard, "the demo home has no billboard");
      check(
        first.billboard.title.matchScore !== null,
        "the demo billboard has no match score (profile looks cold)",
      );
      check(rows.length >= 12, "the demo home has fewer than a dozen rows", {
        observed: `${rows.length}: ${rows.map((row) => row.id).join(", ")}`,
      });
      const kinds = new Set(rows.map((row) => row.kind));
      for (const kind of ["continue-watching", "top-10", "trending", "my-list", "genre"] as const) {
        check(kinds.has(kind), `the demo home has no ${kind} row`, {
          observed: [...kinds].join(", "),
        });
      }
      check(kinds.size >= 6, "the demo home rows are not varied", {
        observed: [...kinds].join(", "),
      });
      const top = rows.find((row) => row.kind === "top-10");
      check(top?.layout === "ranked", "Top 10 is not a ranked row");
      equal(top.items.length, 10, "Top 10 size");
      equal(
        new Set(top.items.map((item) => item.title.id)).size,
        10,
        "distinct titles in the Top 10",
      );
      const allCards = rows.flatMap(cardsOfRow);
      const scored = allCards.filter((card) => card.matchScore !== null).length;
      check(scored / allCards.length >= 0.8, "most demo cards lack a match score", {
        observed: `${scored}/${allCards.length}`,
      });
      ctx.note(
        `${rows.length} rows, ${kinds.size} kinds, billboard ${first.billboard.title.name} (${first.billboard.title.matchScore}% match)`,
      );
    },
  },
  {
    id: "browse.showcase",
    area: "browse",
    title:
      "GET /showcase: curated public artwork (≤ 13+, the catalog's versioned URLs), cacheable by shared caches, revalidates with 304, never personal",
    async run(ctx: CheckContext) {
      const guest = ctx.agent("showcase-guest");
      const response = await guest.fetch(`${API}/showcase`);
      equal(response.status, 200, "GET /showcase without a session", response.exchange);
      const parsed = Showcase.safeParse(response.json());
      if (!parsed.success) {
        fail("the showcase does not match the contract", {
          details: parsed.error.issues
            .slice(0, 8)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          exchange: response.exchange,
        });
      }
      const showcase = parsed.data;
      header(response, "Cache-Control", /^public\b.*\bmax-age=\d+/, "a public, cacheable response");
      header(response, "Vary", (value) => !/cookie/i.test(value ?? ""), "no Vary: Cookie");
      header(response, "Set-Cookie", (value) => value === null, "no cookie on a public response");
      const etag = header(response, "ETag", (value) => value !== null, "a validator");
      const revalidated = await guest.fetch(`${API}/showcase`, {
        headers: { "If-None-Match": etag ?? "" },
      });
      equal(revalidated.status, 304, "revalidation with If-None-Match", revalidated.exchange);

      check(
        showcase.items.length > 0 && showcase.items.length <= SHOWCASE_SIZE,
        "the showcase size",
        { expected: `1..${SHOWCASE_SIZE} titles`, observed: String(showcase.items.length) },
      );
      // The same titles and artwork the catalog serves members, rated at most 13+.
      const { byId } = await ctx.env.catalog();
      for (const item of showcase.items) {
        const card = byId.get(item.id);
        check(card, `${item.id} is not in the catalog`);
        check(
          maturityRank(card.maturity) <= maturityRank(SHOWCASE_MATURITY_CEILING),
          `${item.id} is rated ${card.maturity}, above ${SHOWCASE_MATURITY_CEILING}`,
        );
        equal(`${item.name}/${item.type}`, `${card.name}/${card.type}`, `${item.id} name and type`);
        for (const kind of ["card", "poster", "logo"] as const) {
          equal(
            item.images[kind]?.template ?? null,
            card.images[kind]?.template ?? null,
            `${item.id} ${kind} URL (versioned like the catalog's)`,
          );
        }
      }
      // Nothing personal: a member gets the very same document.
      const member = await ctx.env.browseViewer();
      const signedIn = await succeeds(() => member.agent.api.getShowcase(), "showcase signed in");
      equal(JSON.stringify(signedIn), JSON.stringify(showcase), "the showcase for a member");
      ctx.note(`${showcase.items.length} titles, ${response.headers.get("Cache-Control")}`);
    },
  },
  {
    id: "browse.badges",
    area: "browse",
    title:
      'Badges are the exception: none on the Top 10 row, only "new episodes" in Continue Watching, no "new" on a played title or in New Releases, at most two per row, Top 10 badges matching each view\'s Top 10',
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("badges");
      // Put today's number one in Continue Watching first: a chart-topper the member is watching.
      const before = await browseAll(viewer.agent, "home", 1);
      const ranked = before.rows.find((row) => row.layout === "ranked");
      const leader = ranked?.layout === "ranked" ? ranked.items[0]?.title : undefined;
      if (!leader) ctx.skip("the home page has no Top 10 row");
      await watch(viewer, leader, (session) =>
        Math.min(120, Math.floor(session.durationSec * 0.5)),
      );

      const offenders: string[] = [];
      for (const view of BROWSE_VIEWS) {
        const { rows } = await browseAll(viewer.agent, view, 3);
        const ranks = new Map<string, number>();
        for (const row of rows) {
          if (row.layout !== "ranked") continue;
          for (const item of row.items) ranks.set(item.title.id, item.rank);
        }
        for (const row of rows) {
          const cards = cardsOfRow(row);
          const badged = cards.filter((card) => card.badge === "top-10");
          const any = cards.filter((card) => card.badge !== null);
          if (row.layout === "ranked" && any.length > 0) {
            offenders.push(`${row.id}: ${any.length} badges on the Top 10 row (none allowed)`);
          }
          if (row.layout === "continue" && any.some((card) => card.badge !== "new-episodes")) {
            offenders.push(`${row.id}: a badge other than "new episodes" in Continue Watching`);
          }
          if (row.kind === "new-releases" && any.some((card) => card.badge === "new")) {
            offenders.push(`${row.id}: "new" in New Releases`);
          }
          if (any.length > BADGES_PER_LIST) {
            offenders.push(`${row.id}: ${any.length} badges (at most ${BADGES_PER_LIST})`);
          }
          if (badged.length > TOP_10_BADGES_PER_LIST) {
            offenders.push(
              `${row.id}: ${badged.length} Top 10 badges (at most ${TOP_10_BADGES_PER_LIST})`,
            );
          }
          for (const card of cards) {
            if (card.id === leader.id && card.badge === "new") {
              offenders.push(`${row.id}: "new" on ${card.id}, which this profile has played`);
            }
          }
          if (ranks.size === 0) continue;
          for (const card of cards) {
            if (card.badge === "top-10" && !ranks.has(card.id)) {
              offenders.push(`${row.id}: ${card.id} has the badge but is not in ${view}'s Top 10`);
            }
            if (card.top10Rank !== undefined && card.top10Rank !== ranks.get(card.id)) {
              offenders.push(
                `${row.id}: ${card.id} says #${card.top10Rank}, ${view}'s Top 10 row says #${ranks.get(card.id) ?? "-"}`,
              );
            }
          }
        }
      }
      check(offenders.length === 0, "badges disagree with the Top 10 rows or crowd a row", {
        observed: offenders.slice(0, 10).join("; "),
      });
      const list = await succeeds(
        () => viewer.agent.api.getContinueWatching(),
        "GET /continue-watching",
      );
      const watching = list.items.find((item) => item.title.id === leader.id);
      check(watching, `${leader.id} is not in Continue Watching after watching it`);
      check(
        watching.title.badge === null || watching.title.badge === "new-episodes",
        `a Continue Watching item carries the "${watching.title.badge}" badge`,
      );
      const detail = await succeeds(
        () => viewer.agent.api.getTitle({ params: { id: leader.id } }),
        "the played title's detail",
      );
      check(detail.badge !== "new", "a title this profile has played still says it is new");
      equal(watching.title.top10Rank, 1, "the item still states its rank (for previews)");
    },
  },
  {
    id: "browse.video-quality",
    area: "browse",
    title:
      "Cards, detail and playback state the best quality the packaged media really offers (from its master playlist); external media states none",
    needs: [needs.packagedMedia],
    async run(ctx: CheckContext) {
      const playback = await ctx.env.packagedPlayback();
      if (!playback) ctx.skip("no packaged playback session");
      const heights = playback.master.variants.flatMap((variant) =>
        variant.width && variant.height ? [nominalVideoHeight(variant.width, variant.height)] : [],
      );
      check(heights.length > 0, "the master playlist lists no RESOLUTION");
      const offered = videoQualityForHeight(Math.max(...heights));
      equal(
        playback.session.bestVideoQuality,
        offered,
        `PlaybackSession.bestVideoQuality of ${playback.card.id} (master tops out at ${Math.max(...heights)}p)`,
      );
      const detail = await succeeds(
        () => playback.viewer.agent.api.getTitle({ params: { id: playback.card.id } }),
        "detail",
      );
      const rank = (tier: string | undefined) => VIDEO_QUALITY_TIERS.indexOf(tier as never);
      if (detail.type === "movie")
        equal(detail.bestVideoQuality, offered, "detail bestVideoQuality");
      else {
        // A series states its best episode: at least what this one offers.
        check(
          rank(detail.bestVideoQuality) >= rank(offered),
          "series quality below its episode's",
          {
            expected: `≥ ${offered}`,
            observed: String(detail.bestVideoQuality),
          },
        );
      }
      const card = (await ctx.env.catalog()).byId.get(playback.card.id);
      equal(card?.bestVideoQuality, detail.bestVideoQuality, "card bestVideoQuality");
      const external = (await ctx.env.media()).external;
      if (external) {
        equal(external.session.bestVideoQuality, undefined, "external media session quality");
        const externalDetail = await succeeds(
          () => playback.viewer.agent.api.getTitle({ params: { id: external.card.id } }),
          "detail of an external title",
        );
        if (externalDetail.type === "movie") {
          equal(externalDetail.bestVideoQuality, undefined, "external title quality");
        }
      }
      ctx.note(`${playback.card.id}: ${offered} (master up to ${Math.max(...heights)}p nominal)`);
    },
  },
];
