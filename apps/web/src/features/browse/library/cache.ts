import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  BrowsePage,
  ContinueWatchingList,
  MyListPage,
  Row,
  TitleCard,
} from "@webflix/contracts";
import { qk } from "../../../app/query/keys.ts";

/**
 * Cache surgery for the optimistic library updates. `patchTitleViewer` (platform) flips viewer
 * flags wherever a title appears; these helpers change *membership*: a title joining or leaving
 * My List (the My List page and the My List row) or leaving Continue Watching. Everything here
 * is pure and keeps the identity of untouched branches.
 */

type Infinite<T> = InfiniteData<T, unknown>;

const scopeOf = (key: QueryKey): unknown => key[2];

function isInfinite<T>(data: unknown): data is Infinite<T> {
  return (
    typeof data === "object" && data !== null && Array.isArray((data as { pages?: unknown }).pages)
  );
}

function mapPages<T>(data: Infinite<T>, map: (page: T, index: number) => T): Infinite<T> {
  let changed = false;
  const pages = data.pages.map((page, index) => {
    const next = map(page, index);
    if (next !== page) changed = true;
    return next;
  });
  return changed ? { ...data, pages } : data;
}

function withoutTitle<T extends { id: string }>(items: T[], titleId: string): T[] {
  return items.some((item) => item.id === titleId)
    ? items.filter((item) => item.id !== titleId)
    : items;
}

/** A My List row: the server marks it with kind `my-list` (used for cache upkeep only). */
function patchMyListRow(row: Row, titleId: string, card: TitleCard | null, add: boolean): Row {
  if (row.kind !== "my-list" || (row.layout !== "standard" && row.layout !== "tall")) return row;
  const items = withoutTitle(row.items, titleId);
  if (!add) return items === row.items ? row : { ...row, items };
  if (!card) return row;
  return { ...row, items: [{ ...card, viewer: { ...card.viewer, inMyList: true } }, ...items] };
}

/** Add or remove `titleId` in the My List page and every My List row in the cache entry. */
export function patchMyListMembership(
  data: unknown,
  key: QueryKey,
  titleId: string,
  card: TitleCard | null,
  add: boolean,
): unknown {
  const scope = scopeOf(key);
  if (scope === "my-list" && isInfinite<MyListPage>(data)) {
    return mapPages(data, (page, index) => {
      const items = withoutTitle(page.items, titleId);
      if (add && card && index === 0) {
        return {
          ...page,
          items: [{ ...card, viewer: { ...card.viewer, inMyList: true } }, ...items],
        };
      }
      return items === page.items ? page : { ...page, items };
    });
  }
  if (scope === "browse" && isInfinite<BrowsePage>(data)) {
    return mapPages(data, (page) => {
      let changed = false;
      const rows = page.rows.map((row) => {
        const next = patchMyListRow(row, titleId, card, add);
        if (next !== row) changed = true;
        return next;
      });
      return changed ? { ...page, rows } : page;
    });
  }
  if (scope === "row" && isInfinite<Row>(data)) {
    // Further pages of a My List row: removals only (additions go to the first page).
    return add ? data : mapPages(data, (row) => patchMyListRow(row, titleId, null, false));
  }
  return data;
}

function withoutContinueItem(row: Row, titleId: string): Row {
  if (row.layout !== "continue") return row;
  const items = row.items.filter((item) => item.title.id !== titleId);
  return items.length === row.items.length ? row : { ...row, items };
}

/** Remove a title from every Continue Watching row and list in the cache entry. */
export function removeContinueWatching(data: unknown, key: QueryKey, titleId: string): unknown {
  const scope = scopeOf(key);
  if (scope === "continue-watching" && typeof data === "object" && data !== null) {
    const list = data as ContinueWatchingList;
    const items = list.items.filter((item) => item.title.id !== titleId);
    return items.length === list.items.length ? data : { ...list, items };
  }
  if (scope === "browse" && isInfinite<BrowsePage>(data)) {
    return mapPages(data, (page) => {
      let changed = false;
      const rows = page.rows.map((row) => {
        const next = withoutContinueItem(row, titleId);
        if (next !== row) changed = true;
        return next;
      });
      return changed ? { ...page, rows } : page;
    });
  }
  return data;
}

function isCard(value: unknown, titleId: string): value is TitleCard {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.id === titleId &&
    typeof record.name === "string" &&
    typeof record.images === "object" &&
    typeof record.viewer === "object"
  );
}

/** The freshest cached card for a title (rows, grids, search, details), or null. */
export function findCachedCard(queryClient: QueryClient, titleId: string): TitleCard | null {
  const entries = queryClient
    .getQueryCache()
    .findAll({ queryKey: qk.profile.all() })
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  for (const query of entries) {
    const found = findIn(query.state.data, titleId, 0);
    if (found) return found;
  }
  return null;
}

function findIn(value: unknown, titleId: string, depth: number): TitleCard | null {
  if (depth > 8 || typeof value !== "object" || value === null) return null;
  if (isCard(value, titleId)) return value;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = findIn(child, titleId, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Library changes feed recommendations, so browse pages computed before them are out of date.
 * Mark them stale without refetching now (rows reshuffling under the pointer is worse than a
 * slightly old order); the next visit loads fresh rows.
 */
export function markBrowseStale(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    queryKey: ["webflix", "profile", "browse"],
    refetchType: "none",
  });
}
