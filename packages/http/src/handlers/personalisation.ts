import type { AppContainer } from "../container.ts";
import { requireViewer } from "../session.ts";
import type { AppContext, AreaHandlers } from "./types.ts";

/**
 * The showcase is the same for everyone and changes only with the catalog: browsers and shared
 * caches keep it for five minutes and may serve it stale for a day while revalidating with its
 * ETag (a 304 is a few bytes).
 */
const SHOWCASE_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400";

/**
 * The personalisation area's routes: browse, titles and search (milestone 1), the surfaces the
 * recommendation engine composes. Thin mappings onto `services.browse` and `services.search`.
 */
export function createPersonalisationHandlers(
  container: AppContainer,
): AreaHandlers<"personalisation"> {
  const { services } = container;
  const viewer = (c: AppContext) => requireViewer(container, c);

  return {
    getBrowse: async ({ query }, c) =>
      services.browse.getBrowse(await viewer(c), query.view ?? "home", query.cursor),

    getBrowseRow: async ({ params, query }, c) =>
      services.browse.getRow(await viewer(c), params.rowId, query.cursor, query.limit),

    listGenres: async (_request, c) => services.browse.listGenres(await viewer(c)),

    getGenreBrowse: async ({ params, query }, c) =>
      services.browse.getGenrePage(await viewer(c), params.slug, query),

    getShowcase: async (_request, c) => {
      const { showcase, etag } = await services.browse.getShowcase();
      c.header("Cache-Control", SHOWCASE_CACHE_CONTROL);
      c.header("ETag", etag);
      return showcase;
    },

    getTitle: async ({ params }, c) => services.browse.getTitle(await viewer(c), params.id),

    getTitlePopularity: ({ params }) => services.browse.getTitlePopularity(params.id),

    listEpisodes: async ({ params }, c) =>
      services.browse.listEpisodes(await viewer(c), params.id, params.seasonNumber),

    listSimilar: async ({ params }, c) => services.browse.listSimilar(await viewer(c), params.id),

    search: async ({ query }, c) => services.search.search(await viewer(c), query),
  };
}
