import * as z from "zod";
import {
  BrowsePage,
  BrowseQuery,
  GenreBrowseQuery,
  GenrePage,
  Row,
  RowId,
  SearchQuery,
  SearchResults,
} from "../browse.ts";
import { Id, PageQuery, Slug } from "../common.ts";
import { defineRoute } from "../route.ts";
import {
  GenreList,
  SeasonEpisodes,
  Showcase,
  TitleCardList,
  TitleDetail,
  TitlePopularity,
} from "../titles.ts";

const IdParams = z.object({ id: Id });
const exampleImage = (kind: string, widths: number[], aspectRatio: number) => ({
  template: `/cdn/img/titles/t-sintel/${kind}-{width}.{format}?v=q3Zx81Lm0aRt`,
  widths,
  formats: ["avif", "webp"],
  aspectRatio,
  dominantColor: "#1c2430",
  thumbhash: "HvgJFIIHZ1aXe4eGhnVogIYFSA==",
});

/**
 * Routes of the `personalisation` area. Browse, titles and search (milestone 1): the surfaces the
 * recommendation engine composes, which personalisation owns in milestone 2 (docs/BLUEPRINT-M2.md
 * §7.2). Part of `routes` (src/routes.ts): the key is the operation id and the client method name.
 */
export const personalisationRoutes = {
  getBrowse: defineRoute({
    method: "GET",
    path: "/browse",
    tag: "browse",
    area: "personalisation",
    auth: "profile",
    summary: "A browse view: billboard and personalised rows",
    description: "Rows arrive with their first page of items; `nextCursor` loads more rows.",
    query: BrowseQuery,
    response: BrowsePage,
  }),
  getBrowseRow: defineRoute({
    method: "GET",
    path: "/browse/rows/:rowId",
    tag: "browse",
    area: "personalisation",
    auth: "profile",
    summary: "The next page of items for one row",
    params: z.object({ rowId: RowId }),
    query: PageQuery,
    response: Row,
    errors: ["not_found"],
  }),
  listGenres: defineRoute({
    method: "GET",
    path: "/genres",
    tag: "browse",
    area: "personalisation",
    auth: "profile",
    summary: "All genres",
    response: GenreList,
  }),
  getGenreBrowse: defineRoute({
    method: "GET",
    path: "/browse/genre/:slug",
    tag: "browse",
    area: "personalisation",
    auth: "profile",
    summary: "Titles of one genre, filtered and sorted",
    params: z.object({ slug: Slug }),
    query: GenreBrowseQuery,
    response: GenrePage,
    errors: ["not_found"],
  }),
  getShowcase: defineRoute({
    method: "GET",
    path: "/showcase",
    tag: "titles",
    area: "personalisation",
    auth: "public",
    summary: "Curated artwork for signed-out marketing surfaces",
    description:
      "Public and the same for everyone: cacheable by browsers and shared caches (`Cache-Control: public`, `ETag`, no `Vary: Cookie`). At most `SHOWCASE_SIZE` titles rated at most 13+.",
    response: Showcase,
    examples: {
      response: {
        items: [
          {
            id: "t-sintel",
            name: "Sintel",
            type: "movie",
            images: {
              card: exampleImage("card", [320, 480, 640, 960], 16 / 9),
              poster: exampleImage("poster", [200, 400, 600, 800], 2 / 3),
              logo: exampleImage("logo", [320, 640, 1280], 4),
              backdrop: exampleImage("backdrop", [640, 1280, 1920], 16 / 9),
            },
          },
        ],
      },
    },
  }),
  getTitle: defineRoute({
    method: "GET",
    path: "/titles/:id",
    tag: "titles",
    area: "personalisation",
    auth: "profile",
    summary: "Title detail with the active profile's viewer state",
    params: IdParams,
    response: TitleDetail,
    errors: ["not_found", "maturity_restricted"],
  }),
  listEpisodes: defineRoute({
    method: "GET",
    path: "/titles/:id/seasons/:seasonNumber/episodes",
    tag: "titles",
    area: "personalisation",
    auth: "profile",
    summary: "Episodes of one season with per-episode progress",
    params: z.object({ id: Id, seasonNumber: z.coerce.number<number>().int().positive() }),
    response: SeasonEpisodes,
    errors: ["not_found", "maturity_restricted"],
  }),
  getTitlePopularity: defineRoute({
    method: "GET",
    path: "/titles/:id/popularity",
    tag: "titles",
    area: "personalisation",
    auth: "account",
    summary: "Daily view counters of a title (diagnostics; not in production)",
    description:
      "What Top 10 and Trending are computed from, for the last 7 UTC days as stored. Answers `not_found` when `WEBFLIX_ENV=production`.",
    params: IdParams,
    response: TitlePopularity,
    errors: ["not_found"],
    examples: {
      response: {
        titleId: "t-sintel",
        days: [
          {
            day: "2026-11-21",
            baselineViews: 182,
            playbackViews: 3,
            playbackWatchSec: 1460.5,
            playbackProfiles: 4,
          },
          {
            day: "2026-11-20",
            baselineViews: 175,
            playbackViews: 0,
            playbackWatchSec: 0,
            playbackProfiles: 0,
          },
        ],
      },
    },
  }),
  listSimilar: defineRoute({
    method: "GET",
    path: "/titles/:id/similar",
    tag: "titles",
    area: "personalisation",
    auth: "profile",
    summary: "More like this",
    params: IdParams,
    response: TitleCardList,
    errors: ["not_found", "maturity_restricted"],
  }),
  search: defineRoute({
    method: "GET",
    path: "/search",
    tag: "search",
    area: "personalisation",
    auth: "profile",
    summary: "Search titles, people and genres as you type",
    query: SearchQuery,
    response: SearchResults,
  }),
} as const;
