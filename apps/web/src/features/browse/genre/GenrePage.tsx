import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ApiError, GENRE_SORTS, type GenreSort, type TitleType } from "@webflix/contracts";
import {
  Button,
  EmptyState,
  ErrorState,
  FilmIcon,
  SegmentedControl,
  Select,
  SelectItem,
  Skeleton,
} from "@webflix/ui";
import { useMemo } from "react";
import { useDocumentTitle } from "../../../app/head/DocumentTitle.tsx";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { TitleGrid, TitleGridSkeleton } from "../common/TitleGrid.tsx";

const route = getRouteApi("/profile/browse-shell/browse/genre/$slug");

const SORT_LABELS: Record<GenreSort, string> = {
  suggested: "Suggestions for you",
  newest: "Newest first",
  oldest: "Oldest first",
  "a-z": "A–Z",
  "z-a": "Z–A",
};

const TYPE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "series", label: "Series" },
  { value: "movie", label: "Movies" },
] as const;

/**
 * One genre: every title in it, filterable by type and sortable, loading more as you scroll.
 * Filters live in the URL (shareable, and Back undoes them one by one would be noisy, so they
 * replace the entry).
 */
export function GenrePage() {
  const { slug } = route.useParams();
  const { type, sort } = route.useSearch();
  const navigate = useNavigate();
  const genres = useQuery(queries.genres());
  const filters = { ...(type ? { type } : {}), ...(sort ? { sort } : {}) };
  const page = useInfiniteQuery({
    ...queries.genre(slug, filters),
    placeholderData: keepPreviousData,
  });
  const pages = page.data?.pages;
  const items = useMemo(() => pages?.flatMap((entry) => entry.items) ?? [], [pages]);
  const genre =
    pages?.[0]?.genre ?? genres.data?.items.find((candidate) => candidate.slug === slug);
  useDocumentTitle(genre?.name);

  const setFilter = (next: { type?: TitleType; sort?: GenreSort }) =>
    void navigate({
      to: "/browse/genre/$slug",
      params: { slug },
      search: (previous) => ({ ...previous, ...next }),
      replace: true,
      resetScroll: false,
    });

  if (page.isError && !page.data) {
    const notFound = ApiError.is(page.error, "not_found");
    const error = describeError(page.error);
    return (
      <main id="main" className="pt-nav">
        <ErrorState
          layout="page"
          title={notFound ? "We couldn't find that genre" : error.title}
          description={
            notFound
              ? "It may have been renamed. Browse from the home page instead."
              : error.description
          }
          reference={error.reference}
          action={
            notFound ? (
              <Button variant="primary" asChild>
                <Link to="/browse">Go to home</Link>
              </Button>
            ) : (
              <Button variant="primary" onClick={() => page.refetch()}>
                Try again
              </Button>
            )
          }
        />
      </main>
    );
  }

  const typeLabel = type === "series" ? "series" : type === "movie" ? "movies" : "titles";

  return (
    <main id="main" className="relative pb-16">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-glow" />
      <header className="relative flex flex-col gap-5 px-gutter pt-[calc(var(--spacing-nav)+1.5rem)] pb-8 sm:pt-[calc(var(--spacing-nav)+3rem)] lg:flex-row lg:items-end lg:justify-between">
        <div className="flex max-w-prose flex-col gap-2">
          {genre ? (
            <h1 className="type-display-md text-fg">{genre.name}</h1>
          ) : (
            <Skeleton radius="sm" className="h-12 w-64" />
          )}
          {genre && "description" in genre && genre.description ? (
            <p className="type-body-lg text-fg-muted">{genre.description}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            aria-label="Show"
            size="md"
            value={type ?? "all"}
            options={TYPE_OPTIONS}
            onValueChange={(value) => setFilter({ type: value === "all" ? undefined : value })}
          />
          <Select
            variant="solid"
            aria-label="Sort by"
            value={sort ?? "suggested"}
            onValueChange={(value) =>
              setFilter({
                sort: value === "suggested" ? undefined : (value as GenreSort),
              })
            }
          >
            {GENRE_SORTS.map((option) => (
              <SelectItem key={option} value={option}>
                {SORT_LABELS[option]}
              </SelectItem>
            ))}
          </Select>
        </div>
      </header>

      <div className="relative px-gutter">
        <p role="status" className="sr-only">
          {page.isPending || page.isPlaceholderData
            ? ""
            : `${items.length}${page.hasNextPage ? " or more" : ""} ${typeLabel}`}
        </p>
        {page.isPending ? (
          <TitleGridSkeleton />
        ) : items.length === 0 && !page.isPlaceholderData ? (
          <EmptyState
            icon={FilmIcon}
            title={`No ${typeLabel} in ${genre?.name ?? "this genre"} yet`}
            description="Try another type, or come back soon: new titles arrive every week."
            action={
              type ? (
                <Button variant="outline" onClick={() => setFilter({ type: undefined })}>
                  Show all titles
                </Button>
              ) : (
                <Button variant="outline" asChild>
                  <Link to="/browse">Back to home</Link>
                </Button>
              )
            }
          />
        ) : (
          <TitleGrid
            items={items}
            label={genre ? `${genre.name} ${typeLabel}` : "Titles"}
            scope={`grid:genre:${slug}`}
            stale={page.isPlaceholderData}
            hasMore={page.hasNextPage}
            loadingMore={page.isFetchingNextPage}
            loadMoreFailed={page.isFetchNextPageError}
            onLoadMore={() => void page.fetchNextPage()}
          />
        )}
      </div>
    </main>
  );
}
