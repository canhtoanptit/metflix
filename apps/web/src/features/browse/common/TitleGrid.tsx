import type { TitleCard } from "@webflix/contracts";
import { Button, cx, sliderImageSizes, TitleTileSkeleton, useInView } from "@webflix/ui";
import { type PointerEvent, useEffect, useRef } from "react";
import { TitleTileLink } from "../../../app/links.ts";
import type { TelemetryContext } from "../../../app/telemetry/index.ts";
import { preparePreview } from "../preview/prepare.ts";
import { previewId, requestPreview } from "../preview/request.ts";
import { previewStore } from "../preview/store.ts";
import { durationMs } from "./motion.ts";
import { cardLinkProps } from "./telemetry.ts";

/** Same columns as a row's cards per page (2/3/4/5/6 by breakpoint). */
export const GRID_COLUMNS =
  "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";
const GRID_GAPS = "gap-x-(--slider-gap) gap-y-[max(1.5rem,3.2vw)]";
const SIZES = sliderImageSizes("standard");

export interface TitleGridProps {
  items: readonly TitleCard[];
  /** Accessible name of the list ("Search results", "My List"). */
  label: string;
  /** Hover-preview scope; previews from this grid close when it changes. */
  scope: string;
  /** Where the grid is, for what is opened from it (a card's `rank` is its place in the grid). */
  surface: NonNullable<TelemetryContext["surface"]>;
  /** A card was opened (before the overlay shows it): search reports its click here. */
  onOpen?: (card: TitleCard, rank: number) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMoreFailed?: boolean;
  onLoadMore?: () => void;
  /** Dim while a new query's results are on the way (previous results stay on screen). */
  stale?: boolean;
  className?: string;
}

/**
 * Landscape title cards in a responsive grid that loads more as it nears the end. Pointer
 * hover opens the same preview as rows (edge columns expand inward); touch and keyboard open
 * the detail overlay.
 */
export function TitleGrid({
  items,
  label,
  scope,
  surface,
  onOpen,
  hasMore = false,
  loadingMore = false,
  loadMoreFailed = false,
  onLoadMore,
  stale = false,
  className,
}: TitleGridProps) {
  const gridRef = useRef<HTMLUListElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sentinel, near] = useInView<HTMLDivElement>({ rootMargin: "900px 0px", once: false });

  useEffect(() => {
    if (near && hasMore && !loadingMore && !loadMoreFailed) onLoadMore?.();
  }, [near, hasMore, loadingMore, loadMoreFailed, onLoadMore]);

  // The grid's cards changed (new query, filter, removal): an open preview may point at a card
  // that moved. Viewer-state patches (My List, rating) keep the same cards and leave it open.
  // Appending a page keeps every card in place, so that does not close it either.
  const order = items.map((card) => card.id).join(" ");
  const previousOrder = useRef(order);
  useEffect(() => {
    const before = previousOrder.current;
    previousOrder.current = order;
    if (order !== before && !order.startsWith(before)) previewStore.closeScope(scope);
  }, [order, scope]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const columns = () => {
    const template = gridRef.current ? getComputedStyle(gridRef.current).gridTemplateColumns : "";
    return Math.max(1, template.split(" ").filter(Boolean).length);
  };

  /** The card whose preview was requested (movement on it does not request it again). */
  const hovered = useRef<number | null>(null);

  const onEnter = (event: PointerEvent<HTMLLIElement>, card: TitleCard, index: number) => {
    if (event.pointerType !== "mouse") return;
    const cell = event.currentTarget;
    preparePreview(card, cell.querySelector("a") ?? cell);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const perRow = columns();
      const position = index % perRow;
      const edge = position === 0 ? "start" : position === perRow - 1 ? "end" : null;
      // Declined (the page just scrolled): not hovered, so moving on the card asks again.
      const context = gridContext(surface, index);
      const opened = () => onOpen?.(card, index + 1);
      if (
        requestPreview(
          { scope, layout: "standard", context, onOpen: opened },
          card,
          index,
          cell,
          edge,
        )
      ) {
        hovered.current = index;
      }
    }, previewStore.intentDelay() ?? durationMs("--delay-hover-intent", 450));
  };

  // Movement restarts intent when nothing is pending (a card that slid under a resting pointer).
  const onMove = (event: PointerEvent<HTMLLIElement>, card: TitleCard, index: number) => {
    if (event.pointerType !== "mouse" || timer.current || hovered.current === index) return;
    onEnter(event, card, index);
  };

  const onLeave = (event: PointerEvent<HTMLLIElement>, card: TitleCard, index: number) => {
    if (event.pointerType !== "mouse") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (hovered.current === index) hovered.current = null;
    previewStore.anchorLeft(previewId(scope, card.id, index));
  };

  return (
    <div className={className}>
      <ul
        ref={gridRef}
        aria-label={label}
        aria-busy={stale || loadingMore || undefined}
        className={cx(
          "grid",
          GRID_COLUMNS,
          GRID_GAPS,
          "transition-opacity duration-fast ease-standard",
          stale && "opacity-60",
        )}
      >
        {items.map((card, index) => (
          <li
            key={card.id}
            onPointerEnter={(event) => onEnter(event, card, index)}
            onPointerMove={(event) => onMove(event, card, index)}
            onPointerLeave={(event) => onLeave(event, card, index)}
          >
            <TitleTileLink
              title={card}
              layout="standard"
              sizes={SIZES}
              priority={index < 6}
              {...withOpen(cardLinkProps(card.id, gridContext(surface, index)), () =>
                onOpen?.(card, index + 1),
              )}
            />
          </li>
        ))}
        {loadingMore
          ? Array.from({ length: 6 }, (_, index) => (
              <li key={`loading-${index}`} aria-hidden>
                <TitleTileSkeleton layout="standard" />
              </li>
            ))
          : null}
      </ul>
      {loadMoreFailed ? (
        <div className="mt-8 flex flex-col items-center gap-3">
          <p className="type-body text-fg-muted">More titles couldn't be loaded.</p>
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            Try again
          </Button>
        </div>
      ) : null}
      <div ref={sentinel} aria-hidden className="h-px" />
    </div>
  );
}

/** A grid card's place: its surface and 1-based position (a grid is not a row of the page). */
function gridContext(surface: TitleGridProps["surface"], index: number): TelemetryContext {
  return { surface, rowId: null, rowRank: null, rank: index + 1 };
}

function withOpen<T extends { onClick: (event: { currentTarget: Element }) => void }>(
  props: T,
  opened: () => void,
): T {
  return {
    ...props,
    onClick: (event: { currentTarget: Element }) => {
      opened();
      props.onClick(event);
    },
  };
}

/** The grid's loading state: the same cells, shimmering. */
export function TitleGridSkeleton({
  count = 18,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <ul aria-hidden className={cx("grid", GRID_COLUMNS, GRID_GAPS, className)}>
      {Array.from({ length: count }, (_, index) => (
        <li key={index}>
          <TitleTileSkeleton layout="standard" />
        </li>
      ))}
    </ul>
  );
}
