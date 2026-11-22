import { useInfiniteQuery } from "@tanstack/react-query";
import type {
  BrowseView,
  ContinueWatchingItem,
  RankedItem,
  Row,
  RowLink,
} from "@webflix/contracts";
import { Avatar, BrandMark, RowSlider, type RowSliderHoverEvent } from "@webflix/ui";
import { memo, type PointerEvent, type ReactNode, useCallback, useMemo, useState } from "react";
import { RowExploreLink, TitleTileLink } from "../../../app/links.ts";
import { useAssignmentKey } from "../../../app/session/experiments.ts";
import { useTelemetryScope } from "../../../app/telemetry/index.ts";
import { rowPagesQuery } from "../common/queries.ts";
import { useBrowseProfile } from "../common/session.ts";
import {
  cardLinkProps,
  type Placement,
  placementContext,
  useCardImpression,
  usePlacementContext,
  useRowView,
} from "../common/telemetry.ts";
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
 * A row's heading. Rows are drawn from their layout; the heading alone says what is new about
 * two kinds of row, within the heading's own line (so a row and its loading placeholder keep one
 * height):
 * - the personal row (Top Picks) carries the profile's picture beside the server's title: it is
 *   this profile's row, and it claims nothing about why beyond that;
 * - a curated collection (chosen by Webflix's editors) is marked as one, the way an editor's
 *   pick is signed.
 */
export function RowHeading({ row }: { row: Row }) {
  const profile = useBrowseProfile();
  if (row.kind === "top-picks") {
    return (
      <span className="inline-flex max-w-full items-center gap-[0.45em]">
        <span aria-hidden className="inline-block size-[1.15em] shrink-0">
          <Avatar src={profile.avatar.imageUrl} name={profile.name} size="fill" decorative />
        </span>
        <span className="truncate">{row.title}</span>
      </span>
    );
  }
  if (row.kind === "collection") {
    return (
      // Phones: the mark above the title, so the title keeps the row's width.
      <span className="flex max-w-full flex-col items-start gap-y-1 sm:inline-flex sm:flex-row sm:items-center sm:gap-x-[0.6em]">
        {/* Signed like the Originals' eyebrow ("W SERIES"): chosen by Webflix. */}
        <span
          aria-hidden
          data-testid="collection-mark"
          className="inline-flex shrink-0 items-center gap-1.5"
        >
          <BrandMark className="size-[1.15em]" />
          <span className="type-overline tracking-widest text-fg-muted">Collection</span>
        </span>
        <span className="sr-only">Collection:</span>
        <span className="block max-w-full truncate">{row.title}</span>
      </span>
    );
  }
  return row.title;
}

/**
 * One browse row, drawn from its `layout`. It arrives with its first page; as the person pages
 * towards the loaded end the row fetches its next page (`GET /browse/rows/:id`) and keeps going
 * instead of wrapping. Hover intent opens the shared preview; paging closes it.
 *
 * It reports what the member sees of it: one row view, one impression per card appearance, each
 * at its place on the page (`placement`: the row's rank on the page and the policy of the batch
 * that brought it; a card's rank is its place in the row).
 */
export function BrowseRow({
  row,
  view,
  placement,
  priority = false,
}: {
  row: Row;
  /** The view the row belongs to: a card's Top 10 rank refers to this view's Top 10 row. */
  view: BrowseView;
  placement: Placement;
  priority?: boolean;
}) {
  const assignments = useAssignmentKey();
  const [requested, setRequested] = useState(false);
  const more = useInfiniteQuery({
    ...rowPagesQuery(row.id, row.nextCursor ?? "", assignments),
    enabled: requested && row.nextCursor !== null,
  });
  const merged = useMemo(() => mergeRow(row, more.data?.pages ?? []), [row, more.data]);
  const scope = `row:${row.id}`;
  // Off-page cards load their artwork once the row is seen (or an arrow is reached for).
  const warm = useWarmRow(rowDomId(row.id));
  const loading = warm ? ("eager" as const) : undefined;
  // The first page's size: what the row offered when it was shown (paging further does not make
  // it another view of the row).
  const rowView = useRowView({ rowKind: row.kind, itemCount: row.items.length, placement });
  // What leaves the page's scope (the preview in its portal, the overlay host) carries it whole.
  const scopeContext = useTelemetryScope();

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
        {
          scope,
          layout: row.layout,
          rowTitle: row.title,
          view,
          context: {
            ...scopeContext,
            ...placementContext({ ...placement, rank: event.index + 1 }),
          },
        },
        event.item,
        event.index,
        event.element,
        event.edge,
      ),
    [scope, row.layout, row.title, view, placement, scopeContext],
  );
  const onItemHoverEnd = useCallback(
    (event: { item: RowItem; index: number }) => {
      previewStore.anchorLeft(previewId(scope, cardOf(event.item).id, event.index));
    },
    [scope],
  );
  const onPageChange = useCallback(() => previewStore.closeScope(scope), [scope]);

  if (merged.items.length === 0) return null;

  const common = {
    id: rowDomId(row.id),
    title: <RowHeading row={row} />,
    headerAction: <ExploreLink link={row.link} />,
    layout: row.layout,
    hasMore,
    onEndReached,
    onItemHoverIntent,
    onItemHoverEnd,
    onPageChange,
    hoverIntentDelay: previewStore.intentDelay,
  };
  const card = (item: RowItem, index: number, focusProps: { tabIndex: number }) => (
    <RowCard
      item={item}
      layout={merged.layout}
      placement={placement}
      rank={index + 1}
      priority={priority}
      loading={loading}
      tabIndex={focusProps.tabIndex}
    />
  );

  return (
    <div ref={rowView} data-row-kind={row.kind} data-row-rank={placement.rowRank ?? undefined}>
      {merged.layout === "standard" || merged.layout === "tall" ? (
        <RowSlider
          {...common}
          items={merged.items}
          getKey={(item) => item.id}
          renderItem={(item, { index, focusProps }) => card(item, index, focusProps)}
        />
      ) : merged.layout === "ranked" ? (
        <RowSlider
          {...common}
          items={merged.items}
          getKey={(item) => item.title.id}
          renderItem={(item, { index, focusProps }) => card(item, index, focusProps)}
        />
      ) : (
        <RowSlider
          {...common}
          items={merged.items}
          getKey={(item) => item.title.id}
          renderItem={(item, { index, focusProps }) => card(item, index, focusProps)}
        />
      )}
    </div>
  );
}

interface RowCardProps {
  item: RowItem;
  layout: Row["layout"];
  placement: Placement;
  /** 1-based place in the row, as shown. */
  rank: number;
  priority: boolean;
  loading: "eager" | undefined;
  /** The slider's roving tab stop (its `focusProps`, as a value a memo can compare). */
  tabIndex: number;
}

/**
 * One card of a row: its tile, its impressions, and the open it leads to, at its place.
 * Memoised on values: a page that re-renders (the overlay opening changes the URL) does not
 * re-render every card on it, only the cards whose title, place or tab stop changed.
 */
const RowCard = memo(function RowCard({
  item,
  layout,
  placement,
  rank,
  priority,
  loading,
  tabIndex,
}: RowCardProps) {
  const title = cardOf(item);
  const context = usePlacementContext({ ...placement, rank });
  const impression = useCardImpression({ titleId: title.id, placement: { ...placement, rank } });
  // The hover-intent timer starts now: fetch what the preview will paint on its first frame.
  const prepare = (event: PointerEvent<HTMLAnchorElement>) => {
    if (event.pointerType === "mouse") preparePreview(title, event.currentTarget);
  };
  const shared = {
    ref: impression,
    title,
    priority,
    loading,
    onPointerEnter: prepare,
    ...cardLinkProps(title.id, context),
    tabIndex,
    "data-slider-focus": "",
  };
  if (layout === "ranked" && "rank" in item) {
    return <TitleTileLink {...shared} layout="ranked" rank={(item as RankedItem).rank} />;
  }
  if (layout === "continue" && "progress" in item) {
    const resume = item as ContinueWatchingItem;
    return (
      <TitleTileLink
        {...shared}
        layout="continue"
        progress={resume.progress}
        episode={resume.episode}
      />
    );
  }
  return <TitleTileLink {...shared} layout={layout === "tall" ? "tall" : "standard"} />;
});
