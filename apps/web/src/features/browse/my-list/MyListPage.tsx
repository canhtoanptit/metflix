import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, EmptyState, ErrorState, PlusIcon } from "@webflix/ui";
import { useMemo } from "react";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { useBrowseProfile } from "../common/session.ts";
import { TitleGrid, TitleGridSkeleton } from "../common/TitleGrid.tsx";

/**
 * The profile's saved titles, most recently added first. Removing one (from its preview or
 * details) takes it off the grid at once, with Undo.
 */
export function MyListPage() {
  const profile = useBrowseProfile();
  const list = useInfiniteQuery(queries.myList());
  const pages = list.data?.pages;
  const items = useMemo(() => pages?.flatMap((page) => page.items) ?? [], [pages]);

  return (
    <main
      id="main"
      className="px-gutter pt-[calc(var(--spacing-nav)+1.5rem)] pb-16 sm:pt-[calc(var(--spacing-nav)+3rem)]"
    >
      <h1 className="mb-8 type-headline text-fg">My List</h1>
      {list.isPending ? (
        <TitleGridSkeleton count={12} />
      ) : list.isError && !list.data ? (
        <ErrorState
          title={describeError(list.error).title}
          description={describeError(list.error).description}
          reference={describeError(list.error).reference}
          action={
            <Button variant="primary" onClick={() => list.refetch()}>
              Try again
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={PlusIcon}
          title="Your list is empty"
          description={
            profile.isKids
              ? "Tap + on a show or film to keep it here for later."
              : "Add series and films with + and they'll wait for you here."
          }
          action={
            <Button variant="primary" asChild>
              <Link to="/browse">Find something to watch</Link>
            </Button>
          }
        />
      ) : (
        <TitleGrid
          items={items}
          label="My List"
          scope="grid:my-list"
          surface="my-list"
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          loadMoreFailed={list.isFetchNextPageError}
          onLoadMore={() => void list.fetchNextPage()}
        />
      )}
    </main>
  );
}
