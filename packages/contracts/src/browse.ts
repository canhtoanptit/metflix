import * as z from "zod";
import { Cursor, Id, PageQuery, Slug } from "./common.ts";
import {
  BROWSE_VIEWS,
  GENRE_SORTS,
  ROW_KINDS,
  type RowLayout,
  SEARCH_QUERY_MAX_LENGTH,
} from "./constants.ts";
import { ImageSet } from "./media.ts";
import {
  EpisodeRef,
  Genre,
  GenreRef,
  PlayTarget,
  Progress,
  TitleCard,
  TitleType,
} from "./titles.ts";

export const BrowseView = z.enum(BROWSE_VIEWS).meta({ id: "BrowseView" });
export type BrowseView = z.output<typeof BrowseView>;

export const RowKind = z.enum(ROW_KINDS).meta({ id: "RowKind" });
export type RowKind = z.output<typeof RowKind>;

export const RankedItem = z
  .object({ rank: z.number().int().positive(), title: TitleCard })
  .meta({ id: "RankedItem" });
export type RankedItem = z.output<typeof RankedItem>;

export const ContinueWatchingItem = z
  .object({
    title: TitleCard,
    /** The episode to resume (series), null for movies. */
    episode: EpisodeRef.nullable(),
    progress: Progress,
  })
  .meta({ id: "ContinueWatchingItem" });
export type ContinueWatchingItem = z.output<typeof ContinueWatchingItem>;

export const ContinueWatchingList = z
  .object({ items: z.array(ContinueWatchingItem) })
  .meta({ id: "ContinueWatchingList" });
export type ContinueWatchingList = z.output<typeof ContinueWatchingList>;

/** Where a row's "Explore all" affordance leads; null when it has none. */
export const RowLink = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("genre"), slug: Slug }),
    z.object({ kind: z.literal("my-list") }),
    z.object({ kind: z.literal("view"), view: BrowseView }),
  ])
  .meta({ id: "RowLink" });
export type RowLink = z.output<typeof RowLink>;

/** Structured inputs of the row title, for clients that localise titles themselves. */
export const RowContext = z
  .object({
    sourceTitle: z.object({ id: Id, name: z.string() }).nullable(),
    genre: GenreRef.nullable(),
  })
  .meta({ id: "RowContext" });
export type RowContext = z.output<typeof RowContext>;

/** Stable, opaque row id; pass it to `GET /browse/rows/:rowId` for more items. */
export const RowId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:~-]+$/)
  .meta({ description: "Opaque row id (URL-safe)." });

const rowBase = {
  id: RowId,
  kind: RowKind,
  /** Display title, already localised and interpolated ("Because you watched Sintel"). */
  title: z.string(),
  context: RowContext,
  link: RowLink.nullable(),
  /** Cursor for the next page of this row's items; null when the row is exhausted. */
  nextCursor: Cursor.nullable(),
};

/**
 * One row of the browse page. Discriminated by `layout`. Rows arrive with their first page
 * of items; `GET /browse/rows/:rowId?cursor=` returns the same shape with the next page.
 */
export const Row = z
  .discriminatedUnion("layout", [
    z.object({ ...rowBase, layout: z.literal("standard"), items: z.array(TitleCard) }),
    z.object({ ...rowBase, layout: z.literal("tall"), items: z.array(TitleCard) }),
    z.object({ ...rowBase, layout: z.literal("ranked"), items: z.array(RankedItem) }),
    z.object({ ...rowBase, layout: z.literal("continue"), items: z.array(ContinueWatchingItem) }),
  ])
  .meta({ id: "Row" });
export type Row = z.output<typeof Row>;
export type RowOfLayout<L extends RowLayout> = Extract<Row, { layout: L }>;

/** The hero at the top of a browse view. */
export const Billboard = z
  .object({
    title: TitleCard,
    synopsis: z.string(),
    backdrop: ImageSet,
    maturityDescriptors: z.array(z.string()),
    playTarget: PlayTarget.nullable(),
  })
  .meta({ id: "Billboard" });
export type Billboard = z.output<typeof Billboard>;

export const BrowseQuery = z.object({
  view: BrowseView.optional().meta({ description: "Defaults to home." }),
  cursor: Cursor.optional().meta({ description: "Cursor for the next batch of rows." }),
});
export type BrowseQuery = z.input<typeof BrowseQuery>;

export const BrowsePage = z
  .object({
    view: BrowseView,
    /** Present on the first batch only. */
    billboard: Billboard.nullable(),
    rows: z.array(Row),
    /** Cursor for the next batch of rows (lazy-loaded as the user scrolls). */
    nextCursor: Cursor.nullable(),
  })
  .meta({ id: "BrowsePage" });
export type BrowsePage = z.output<typeof BrowsePage>;

// --- Genre pages ------------------------------------------------------------------------------

export const GenreSort = z.enum(GENRE_SORTS).meta({ id: "GenreSort" });
export type GenreSort = z.output<typeof GenreSort>;

export const GenreBrowseQuery = PageQuery.extend({
  type: TitleType.optional().meta({ description: "Restrict to movies or series." }),
  sort: GenreSort.optional().meta({ description: "Defaults to suggested." }),
});
export type GenreBrowseQuery = z.input<typeof GenreBrowseQuery>;

export const GenrePage = z
  .object({
    genre: Genre,
    type: TitleType.nullable(),
    sort: GenreSort,
    items: z.array(TitleCard),
    nextCursor: Cursor.nullable(),
  })
  .meta({ id: "GenrePage" });
export type GenrePage = z.output<typeof GenrePage>;

// --- Search -----------------------------------------------------------------------------------

export const SearchQuery = PageQuery.extend({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH),
});
export type SearchQuery = z.input<typeof SearchQuery>;

export const SearchSuggestion = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("title"), id: Id, name: z.string() }),
    z.object({ kind: z.literal("person"), id: Id, name: z.string() }),
    z.object({ kind: z.literal("genre"), slug: Slug, name: z.string() }),
  ])
  .meta({ id: "SearchSuggestion" });
export type SearchSuggestion = z.output<typeof SearchSuggestion>;

/**
 * Titles matching by name, people, genres or moods (already maturity-filtered), plus
 * entity suggestions for the "Explore titles related to" strip. Empty `results` and
 * `suggestions` is the empty state.
 */
export const SearchResults = z
  .object({
    query: z.string(),
    results: z.array(TitleCard),
    suggestions: z.array(SearchSuggestion),
    nextCursor: Cursor.nullable(),
  })
  .meta({ id: "SearchResults" });
export type SearchResults = z.output<typeof SearchResults>;
