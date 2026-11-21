import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { SearchSuggestion } from "@webflix/contracts";
import { Button, cx, ErrorState, SearchIcon, Skeleton } from "@webflix/ui";
import { Fragment, useMemo } from "react";
import { useDocumentTitle } from "../../../app/head/DocumentTitle.tsx";
import { titleOverlayLinkProps } from "../../../app/overlay/titleOverlay.ts";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { TitleGrid, TitleGridSkeleton } from "../common/TitleGrid.tsx";

const route = getRouteApi("/profile/browse-shell/search");

/**
 * Search results for `?q=` (typed in the navigation's search field). Previous results stay on
 * screen, dimmed, while the next query loads; "Explore titles related to" offers the titles,
 * people and genres the query matched; an empty query or no match offers genres to browse.
 */
export function SearchPage() {
  const { q } = route.useSearch();
  const query = (q ?? "").trim();
  useDocumentTitle(query ? `Search: ${query}` : "Search");

  return (
    <main
      id="main"
      className="px-gutter pt-[calc(var(--spacing-nav)+1.5rem)] pb-16 sm:pt-[calc(var(--spacing-nav)+2.5rem)]"
    >
      {query ? <Results query={query} /> : <SearchHome />}
    </main>
  );
}

function Results({ query }: { query: string }) {
  const search = useInfiniteQuery({ ...queries.search(query), placeholderData: keepPreviousData });
  const pages = search.data?.pages;
  const results = useMemo(() => pages?.flatMap((page) => page.results) ?? [], [pages]);
  const suggestions = pages?.[0]?.suggestions ?? [];
  const shownQuery = pages?.[0]?.query ?? query;

  if (search.isError && !search.data) {
    const error = describeError(search.error);
    return (
      <ErrorState
        layout="page"
        title={error.title}
        description={error.description}
        reference={error.reference}
        action={
          <Button variant="primary" onClick={() => search.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <>
      <h1 className="sr-only">Search results for “{query}”</h1>
      <p role="status" className="sr-only">
        {search.isPending || search.isPlaceholderData
          ? ""
          : results.length === 0
            ? `No results for ${query}`
            : `${results.length}${search.hasNextPage ? " or more" : ""} results for ${query}`}
      </p>
      {search.isPending ? (
        <>
          <Skeleton radius="sm" className="mb-8 h-5 w-72 max-w-full" />
          <TitleGridSkeleton />
        </>
      ) : results.length === 0 && !search.isPlaceholderData ? (
        <NoResults query={shownQuery} suggestions={suggestions} />
      ) : (
        <>
          <Suggestions suggestions={suggestions} />
          <TitleGrid
            items={results}
            label={`Results for ${shownQuery}`}
            scope="grid:search"
            stale={search.isPlaceholderData}
            hasMore={search.hasNextPage}
            loadingMore={search.isFetchingNextPage}
            loadMoreFailed={search.isFetchNextPageError}
            onLoadMore={() => void search.fetchNextPage()}
          />
        </>
      )}
    </>
  );
}

/** "Explore titles related to: Sintel | Mara Okafor | Sci-Fi" */
function Suggestions({ suggestions }: { suggestions: readonly SearchSuggestion[] }) {
  if (suggestions.length === 0) return <div className="mb-8" />;
  return (
    <nav
      aria-label="Related"
      className={cx(
        "mb-8 flex items-baseline gap-x-3 gap-y-2 type-body sm:flex-wrap",
        // Phones: one swipeable line, so the results stay above the fold.
        "max-sm:scrollbar-none max-sm:-mx-gutter max-sm:overflow-x-auto max-sm:whitespace-nowrap max-sm:px-gutter",
      )}
    >
      <span className="shrink-0 text-fg-subtle">Explore titles related to:</span>
      {suggestions.map((suggestion, index) => (
        <Fragment
          key={`${suggestion.kind}:${"id" in suggestion ? suggestion.id : suggestion.slug}`}
        >
          {index > 0 ? (
            <span aria-hidden className="text-fg-subtle">
              |
            </span>
          ) : null}
          <SuggestionLink suggestion={suggestion} />
        </Fragment>
      ))}
    </nav>
  );
}

const SUGGESTION_CLASS =
  "focus-ring rounded-xs text-fg transition-colors duration-fast ease-standard hover:text-accent";

function SuggestionLink({ suggestion }: { suggestion: SearchSuggestion }) {
  switch (suggestion.kind) {
    case "title":
      return (
        <Link {...titleOverlayLinkProps(suggestion.id)} className={SUGGESTION_CLASS}>
          {suggestion.name}
        </Link>
      );
    case "person":
      return (
        <Link to="/search" search={{ q: suggestion.name }} className={SUGGESTION_CLASS}>
          {suggestion.name}
        </Link>
      );
    case "genre":
      return (
        <Link
          to="/browse/genre/$slug"
          params={{ slug: suggestion.slug }}
          search={{}}
          className={SUGGESTION_CLASS}
        >
          {suggestion.name}
        </Link>
      );
  }
}

function NoResults({
  query,
  suggestions,
}: {
  query: string;
  suggestions: readonly SearchSuggestion[];
}) {
  return (
    <div className="flex max-w-prose flex-col items-start gap-4 py-6">
      <p className="type-title-lg text-fg">Your search for “{query}” did not have any matches.</p>
      <div className="type-body text-fg-muted">
        <p>Suggestions:</p>
        <ul className="mt-2 list-disc ps-6">
          <li>Try different keywords</li>
          <li>Looking for a film or series? Try its title, an actor or a director</li>
          <li>Try a genre, like comedy, thriller or documentary</li>
        </ul>
      </div>
      {suggestions.length > 0 ? <Suggestions suggestions={suggestions} /> : null}
      <GenreChips heading="Or browse a genre" />
    </div>
  );
}

function SearchHome() {
  return (
    <div className="flex max-w-page flex-col gap-6 py-4">
      <h1 className="flex items-center gap-3 type-headline text-fg">
        <SearchIcon size="xl" className="text-fg-subtle" />
        Find something to watch
      </h1>
      <p className="type-body-lg text-fg-muted">
        Search by title, person or genre — or start from a genre.
      </p>
      <GenreChips heading="Browse by genre" />
    </div>
  );
}

function GenreChips({ heading }: { heading: string }) {
  const genres = useQuery(queries.genres());
  return (
    <section aria-labelledby="search-genres" className="mt-4 w-full">
      <h2 id="search-genres" className="type-row-title text-fg">
        {heading}
      </h2>
      <ul className="mt-4 flex flex-wrap gap-2">
        {genres.isPending
          ? Array.from({ length: 10 }, (_, index) => (
              <li key={index}>
                <Skeleton radius="full" className="h-10 w-28" />
              </li>
            ))
          : (genres.data?.items ?? []).map((genre) => (
              <li key={genre.id}>
                <Link
                  to="/browse/genre/$slug"
                  params={{ slug: genre.slug }}
                  search={{}}
                  className="focus-ring inline-flex h-10 items-center rounded-full border border-line-strong px-4 type-label text-fg transition-colors duration-fast ease-standard hover:border-fg hover:bg-surface-3"
                >
                  {genre.name}
                </Link>
              </li>
            ))}
      </ul>
    </section>
  );
}
