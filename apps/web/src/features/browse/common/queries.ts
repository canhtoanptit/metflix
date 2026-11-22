import { infiniteQueryOptions } from "@tanstack/react-query";
import type {
  BrowsePage,
  BrowseView,
  GenrePage,
  GenreSort,
  Row,
  TitleType,
} from "@webflix/contracts";
import { api } from "../../../app/api.ts";
import { qk } from "../../../app/query/keys.ts";

const MINUTE = 60_000;

/**
 * Browse pages and row pages, cached per experiment assignment (`assignmentKey`): the server
 * ranks them by the policy the assignment picks, so a page fetched under one assignment is never
 * shown under another. Keys extend the platform's (`qk.profile.browse`, `qk.profile.row`), so
 * profile switches, library patches and staleness marks reach them by prefix as before.
 */
export function browsePageQuery(view: BrowseView, assignments: string) {
  return infiniteQueryOptions({
    queryKey: [...qk.profile.browse(view), { assignments }] as const,
    queryFn: ({ pageParam, signal }) =>
      api().getBrowse({ query: { view, cursor: pageParam } }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: BrowsePage) => page.nextCursor ?? undefined,
    staleTime: 2 * MINUTE,
    // No placeholder from another key: after a profile switch the previous query (same key,
    // removed with the profile's caches) would paint the other profile's page meanwhile.
  });
}

/** Further items of one row (its first page arrives inside the browse page). */
export function rowPagesQuery(rowId: string, firstCursor: string, assignments: string) {
  return infiniteQueryOptions({
    queryKey: [...qk.profile.row(rowId), { assignments }] as const,
    queryFn: ({ pageParam, signal }) =>
      api().getBrowseRow({ params: { rowId }, query: { cursor: pageParam } }, { signal }),
    initialPageParam: firstCursor,
    getNextPageParam: (row: Row) => row.nextCursor ?? undefined,
    // A row that is gone (a collection unpublished, the page recomposed since) simply ends where
    // it is: never a toast about a row the member is only paging through.
    meta: { silent: true },
  });
}

/** A genre page: its "suggested" order is the ranking policy's, so it is cached per assignment. */
export function genrePageQuery(
  slug: string,
  filters: { type?: TitleType; sort?: GenreSort },
  assignments: string,
) {
  return infiniteQueryOptions({
    queryKey: [...qk.profile.genre(slug, filters), { assignments }] as const,
    queryFn: ({ pageParam, signal }) =>
      api().getGenreBrowse(
        { params: { slug }, query: { ...filters, cursor: pageParam } },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: GenrePage) => page.nextCursor ?? undefined,
  });
}
