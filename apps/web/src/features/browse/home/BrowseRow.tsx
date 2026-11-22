import { useInfiniteQuery } from "@tanstack/react-query";
import type { BrowseView, Row, RowLink } from "@webflix/contracts";
import { RowSlider, type RowSliderHoverEvent } from "@webflix/ui";
import { type PointerEvent, type ReactNode, useCallback, useMemo, useState } from "react";
import { RowExploreLink, TitleTileLink } from "../../../app/links.ts";
import { titleOverlayLinkProps } from "../../../app/overlay/titleOverlay.ts";
import { queries } from "../../../app/query/queries.ts";
import { preparePreview } from "../preview/prepare.ts";
import { cardOf, mergeRow, previewId, type RowItem, requestPreview } from "../preview/request.ts";
import { previewStore } from "../preview/store.ts";
import { useWarmRow } from "./useWarmRow.ts";

const VIEW_PATHS: Record<
  BrowseView,
  "/browse" | "/browse/series" | "/browse/movies" | "/browse/new-popular"
> = {
  home: "/browse",
  series: "/browse/series",
  movies: "/browse/movies",
  "new-popular": "/browse/new-popular",
};

function ExploreLink({ link }: { link: RowLink | null }): ReactNode {
  if (!link) return null;
  switch (link.kind) {
    case "genre":
      return <RowExploreLink to="/browse/genre/$slug" params={{ slug: link.slug }} search={{}} />;
    case "my-list":
      return <RowExploreLink to="/my-list" />;
    case "view":
      return <RowExploreLink to={VIEW_PATHS[link.view]} />;
  }
}

/** DOM-safe id for a row (`home:genre:drama` → `row-home-genre-drama`). */
export function rowDomId(rowId: string): string {
  return `row-${rowId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * One browse row, drawn from its `layout`. It arrives with its first page; as the person pages
 * towards the loaded end the row fetches its next page (`GET /browse/rows/:id`) and keeps going
 * instead of wrapping. Hover intent opens the shared preview; paging closes it.
 */
export function BrowseRow({
  row,
  view,
  priority = false,
}: {
  row: Row;
  /** The view the row belongs to: a card's Top 10 rank refers to this view's Top 10 row. */
  view: BrowseView;
  priority?: boolean;
}) {
  const [requested, setRequested] = useState(false);
  const more = useInfiniteQuery({
    ...queries.row(row.id, row.nextCursor ?? ""),
    enabled: requested && row.nextCursor !== null,
  });
  const merged = useMemo(() => mergeRow(row, more.data?.pages ?? []), [row, more.data]);
  const scope = `row:${row.id}`;
  // Off-page cards load their artwork once the row is seen (or an arrow is reached for).
  const warm = useWarmRow(rowDomId(row.id));
  const loading = warm ? ("eager" as const) : undefined;

  const hasMore =
    row.nextCursor === null
      ? false
      : !requested
        ? true
        : more.isError
          ? false
          : more.isPending || more.hasNextPage;

  const onEndReached = useCallback(() => {
    if (!requested) setRequested(true);
    else if (more.hasNextPage && !more.isFetchingNextPage) void more.fetchNextPage();
  }, [requested, more]);

  const onItemHoverIntent = useCallback(
    (event: RowSliderHoverEvent<RowItem>) =>
      requestPreview(
        { scope, layout: row.layout, rowTitle: row.title, view },
        event.item,
        event.index,
        event.element,
        event.edge,
      ),
    [scope, row.layout, row.title, view],
  );
  const onItemHoverEnd = useCallback(
    (event: { item: RowItem; index: number }) => {
      const id =
        "rank" in event.item || "progress" in event.item ? event.item.title.id : event.item.id;
      previewStore.anchorLeft(previewId(scope, id, event.index));
    },
    [scope],
  );
  const onPageChange = useCallback(() => previewStore.closeScope(scope), [scope]);
  // The hover-intent timer starts now: fetch what the preview will paint on its first frame.
  const prepare = (item: RowItem) => (event: PointerEvent<HTMLAnchorElement>) => {
    if (event.pointerType === "mouse") preparePreview(cardOf(item), event.currentTarget);
  };

  if (merged.items.length === 0) return null;

  const common = {
    id: rowDomId(row.id),
    title: row.title,
    headerAction: <ExploreLink link={row.link} />,
    layout: row.layout,
    hasMore,
    onEndReached,
    onItemHoverIntent,
    onItemHoverEnd,
    onPageChange,
    hoverIntentDelay: previewStore.intentDelay,
  };

  switch (merged.layout) {
    case "standard":
    case "tall":
      return (
        <RowSlider
          {...common}
          items={merged.items}
          getKey={(item) => item.id}
          renderItem={(item, { focusProps }) => (
            <TitleTileLink
              title={item}
              layout={merged.layout}
              priority={priority}
              loading={loading}
              onPointerEnter={prepare(item)}
              {...titleOverlayLinkProps(item.id)}
              {...focusProps}
            />
          )}
        />
      );
    case "ranked":
      return (
        <RowSlider
          {...common}
          items={merged.items}
          getKey={(item) => item.title.id}
          renderItem={(item, { focusProps }) => (
            <TitleTileLink
              title={item.title}
              layout="ranked"
              rank={item.rank}
              priority={priority}
              loading={loading}
              onPointerEnter={prepare(item)}
              {...titleOverlayLinkProps(item.title.id)}
              {...focusProps}
            />
          )}
        />
      );
    case "continue":
      return (
        <RowSlider
          {...common}
          items={merged.items}
          getKey={(item) => item.title.id}
          renderItem={(item, { focusProps }) => (
            <TitleTileLink
              title={item.title}
              layout="continue"
              progress={item.progress}
              episode={item.episode}
              priority={priority}
              loading={loading}
              onPointerEnter={prepare(item)}
              {...titleOverlayLinkProps(item.title.id)}
              {...focusProps}
            />
          )}
        />
      );
  }
}
