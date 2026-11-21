import { DEFAULT_PAGE_SIZE, type SearchResults, type SearchSuggestion } from "@webflix/contracts";
import type { Personalization } from "../recommendations/engine.ts";
import type { ServiceDependencies, Viewer } from "./context.ts";
import { presentCards } from "./presenters.ts";

const SUGGESTION_LIMIT = 8;

export function createSearchService(
  deps: ServiceDependencies,
  personalize: (viewer: Viewer) => Promise<Personalization>,
) {
  return {
    async search(
      viewer: Viewer,
      query: { q: string; cursor?: string | undefined; limit?: number | undefined },
    ): Promise<SearchResults> {
      const ceiling = viewer.profile.maturityCeiling;
      // Maturity is filtered inside the index (pages never come up short); suggestions only
      // on the first page, where the "Explore titles related to" strip is shown.
      const [personalization, page, suggestions] = await Promise.all([
        personalize(viewer),
        deps.search.search({
          text: query.q,
          maturityCeiling: ceiling,
          limit: query.limit ?? DEFAULT_PAGE_SIZE,
          cursor: query.cursor ?? null,
        }),
        query.cursor
          ? Promise.resolve([])
          : deps.search.suggest({
              text: query.q,
              maturityCeiling: ceiling,
              limit: SUGGESTION_LIMIT,
            }),
      ]);
      const ids = page.hits.map((hit) => hit.id).filter((id) => personalization.isVisible(id));
      return {
        query: query.q,
        results: presentCards(
          personalization,
          ids,
          personalization.cardSurface(ids, "home", "list"),
        ),
        suggestions: suggestions.map(
          (hit): SearchSuggestion =>
            hit.kind === "genre"
              ? { kind: "genre", slug: hit.id, name: hit.label }
              : { kind: hit.kind, id: hit.id, name: hit.label },
        ),
        nextCursor: page.nextCursor,
      };
    },
  };
}

export type SearchService = ReturnType<typeof createSearchService>;
