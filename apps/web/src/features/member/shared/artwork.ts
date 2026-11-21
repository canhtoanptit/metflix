import { queryOptions, useQuery } from "@tanstack/react-query";
import type { ImageSet, ShowcaseTitle } from "@webflix/contracts";
import { api } from "../../../app/api.ts";

/**
 * Catalog artwork for signed-out screens, from the public showcase (`GET /showcase`): curated
 * titles rated 13+ at most, with the catalog's versioned image URLs, so immutable caching never
 * shows stale art. The response is the same for everyone (global scope, like the plans) and
 * cacheable; route loaders prefetch it so the posters are requested as early as the page code.
 * The artwork is decoration: while it loads, or if it cannot, the screens work without it.
 */
export const showcaseQuery = () =>
  queryOptions({
    queryKey: ["webflix", "showcase"] as const,
    queryFn: ({ signal }) => api().getShowcase(undefined, { signal }),
    staleTime: 5 * 60_000,
    meta: { silent: true },
  });

/** The showcase titles, best first; empty while loading or when unavailable. */
export function useShowcase(): readonly ShowcaseTitle[] {
  return useQuery(showcaseQuery()).data?.items ?? [];
}

/** Artwork of the `index`-th showcase title (cycling through the list); null when there is none. */
export function showcaseImage(
  items: readonly ShowcaseTitle[],
  index: number,
  kind: "card" | "poster" | "backdrop",
): ImageSet | null {
  if (items.length === 0) return null;
  return items[index % items.length]?.images[kind] ?? null;
}
