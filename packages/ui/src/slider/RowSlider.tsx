import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  type TransitionEvent,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { ChevronLeftIcon, ChevronRightIcon } from "../icons/icons.tsx";
import { readCssTime } from "../lib/css-time.ts";
import { cx } from "../lib/cx.ts";
import { prefersReducedMotion, useCanHover, useLatest } from "../lib/hooks.ts";
import {
  beginMove,
  canPage,
  commitMove,
  currentPage,
  edgeOf,
  INITIAL_SLIDER_STATE,
  isVisible,
  mod,
  nearsEnd,
  nextShift,
  pageCount,
  prevShift,
  realign,
  renderWindow,
  type SliderState,
  shiftToPage,
  trackOffset,
} from "./model.ts";

export type SliderMode = "paged" | "scroll";

/** Passed to `renderItem` for every rendered item. */
export interface RowSliderItemContext {
  /** Index into `items`. */
  index: number;
  /** Fully inside the current page (off-page items are inert). */
  visible: boolean;
  /** First or last visible position: a hover preview should expand inward from here. */
  edge: "start" | "end" | null;
  /**
   * Spread onto the item's focusable element (its link or button): roving tabindex (one Tab stop
   * per row, arrow keys inside) and the hook the slider uses to move focus.
   */
  focusProps: { tabIndex: number; "data-slider-focus": "" };
}

/** Hover intent on a visible item (pointer devices only). Everything a preview needs to place itself. */
export interface RowSliderHoverEvent<T> {
  item: T;
  index: number;
  /** The item's cell; its rect is the preview's origin. Read again on scroll if you need to. */
  element: HTMLElement;
  rect: DOMRect;
  edge: "start" | "end" | null;
  /** 0-based position on the visible page, and the page size. */
  position: number;
  perPage: number;
}

export interface RowSliderHandle {
  next: () => void;
  prev: () => void;
  goToPage: (page: number) => void;
  /** The cell element of an item currently rendered and visible, if any. */
  getItemElement: (index: number) => HTMLElement | null;
  /** Indices of the visible items, in display order. */
  getVisibleIndices: () => number[];
  isAnimating: () => boolean;
  getMode: () => SliderMode;
}

export interface RowSliderProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T, context: RowSliderItemContext) => ReactNode;
  /** Visible row title (also the carousel's accessible name). */
  title: ReactNode;
  headingLevel?: 2 | 3;
  /** Rendered next to the title, e.g. an "Explore all" link (`RowHeaderLink`). */
  headerAction?: ReactNode;
  /** `layout` of the contract row; tunes paging labels only (sizes come from CSS). */
  layout?: "standard" | "tall" | "ranked" | "continue";
  /** `auto` (default): paged on hover-capable pointers, native scrolling on touch-first devices. */
  mode?: "auto" | SliderMode;
  /** More items can be fetched for this row (the row's `nextCursor` is not null). */
  hasMore?: boolean;
  /** Called when the user nears the loaded end; fetch the next page of the row. */
  onEndReached?: () => void;
  onPageChange?: (page: number, pageCount: number) => void;
  /**
   * Hover intent after `hoverIntentDelay` on a visible item. Suppressed while moving. Return
   * `false` if the intent was declined (say, the page is still settling after a scroll): the
   * item then does not count as hovered, so further pointer movement on it starts intent again.
   */
  onItemHoverIntent?: (event: RowSliderHoverEvent<T>) => boolean | undefined;
  /** The pointer left an item (or the row started moving). A hint: the preview owns its closing. */
  onItemHoverEnd?: (event: { item: T; index: number }) => void;
  /**
   * Milliseconds before hover intent fires (default: the `--delay-hover-intent` token). A
   * function is read when the pointer enters a card, so the delay can depend on state (a
   * shorter "warm" delay right after a preview closed, like tooltips' skip delay); returning
   * undefined means the default.
   */
  hoverIntentDelay?: number | (() => number | undefined);
  ref?: Ref<RowSliderHandle>;
  className?: string;
  /** Test/reference hook: show arrows and page indicators without hover. */
  forceControls?: boolean;
  id?: string;
}

interface DragState {
  pointerId: number;
  x0: number;
  y0: number;
  decided: "drag" | "scroll" | null;
  dx: number;
  samples: Array<{ x: number; t: number }>;
}

const DRAG_THRESHOLD_PX = 8;
const FLICK_VELOCITY = 0.35; // px/ms
const DEFAULT_HOVER_DELAY = 450;

function readPerPage(track: HTMLElement | null): number {
  if (!track) return 6;
  const raw = getComputedStyle(track).getPropertyValue("--per-page").trim();
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 6;
}

/** Pointer capture is best-effort: it throws for pointers the browser no longer tracks. */
function capturePointer(element: HTMLElement | null, pointerId: number, capture: boolean): void {
  try {
    if (capture) element?.setPointerCapture(pointerId);
    else if (element?.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // The gesture still works without capture; it may just end early if the finger leaves.
  }
}

function resolveHoverDelay(delay: number | (() => number | undefined) | undefined): number {
  const value = typeof delay === "function" ? delay() : delay;
  return value ?? readHoverDelay();
}

function readHoverDelay(): number {
  return readCssTime("--delay-hover-intent") ?? DEFAULT_HOVER_DELAY;
}

/**
 * The browse row: a paged carousel with peeking neighbours, page indicators, arrows on hover,
 * wrap-around after the first page, touch swipe with momentum, roving keyboard focus, live
 * announcements and lazy rendering (only ~3 pages are in the DOM). On touch-first devices it is
 * a native scroll-snap row instead.
 *
 * The row clips horizontally. Hover previews that must escape that clip are rendered by the app
 * in a portal, positioned from `onItemHoverIntent` (rect, edge) — see docs/DESIGN_SYSTEM.md.
 */
export function RowSlider<T>({
  items,
  getKey,
  renderItem,
  title,
  headingLevel = 2,
  headerAction,
  layout = "standard",
  mode: modeProp = "auto",
  hasMore = false,
  onEndReached,
  onPageChange,
  onItemHoverIntent,
  onItemHoverEnd,
  hoverIntentDelay,
  ref,
  className,
  forceControls = false,
  id: idProp,
}: RowSliderProps<T>) {
  const canHover = useCanHover();
  const mode: SliderMode = modeProp === "auto" ? (canHover ? "paged" : "scroll") : modeProp;
  const generatedId = useId();
  const baseId = idProp ?? `row-${generatedId.replaceAll(":", "")}`;
  const headingId = `${baseId}-title`;
  const trackId = `${baseId}-track`;

  const rootRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLUListElement>(null);
  const [perPage, setPerPage] = useState(6);
  const [state, setState] = useState<SliderState>(INITIAL_SLIDER_STATE);
  const [announcement, setAnnouncement] = useState("");
  const [activeVirtual, setActiveVirtual] = useState(0);
  const stateRef = useLatest(state);
  const pendingFocus = useRef<number | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef<{ item: T; index: number } | null>(null);
  const callbacks = useLatest({ onEndReached, onPageChange, onItemHoverIntent, onItemHoverEnd });

  const count = items.length;
  const pageable = mode === "paged" && canPage(count, perPage);
  const pages = pageCount(count, perPage);
  const page = pageable ? currentPage(state.start, count, perPage) : 0;

  // ---- Page size from CSS (container queries), kept in sync on resize ----------------------
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setPerPage(readPerPage(trackRef.current));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Keep the first visible item on a page boundary when page size or item count changes.
  useLayoutEffect(() => {
    setState((current) => realign(current, count, perPage));
  }, [count, perPage]);

  // ---- Fetch more as the user nears the loaded end ------------------------------------------
  const requestedAt = useRef(-1);
  useEffect(() => {
    if (!hasMore || count === 0) return;
    if (mode === "paged" && !nearsEnd(state, count, perPage)) return;
    if (mode === "scroll") return; // scroll mode asks from its scroll handler
    if (requestedAt.current === count) return;
    requestedAt.current = count;
    callbacks.current.onEndReached?.();
  }, [hasMore, count, perPage, state, mode, callbacks]);

  // ---- Moving --------------------------------------------------------------------------------
  const endHover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (hovered.current) {
      callbacks.current.onItemHoverEnd?.(hovered.current);
      hovered.current = null;
    }
  }, [callbacks]);

  const settle = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    const track = trackRef.current;
    track?.style.removeProperty("--slider-duration");
    track?.style.removeProperty("--slider-ease");
    setState((current) => (current.animating ? commitMove(current) : current));
  }, []);

  const move = useCallback(
    (
      shift: number,
      options: { durationMs?: number; momentum?: boolean; fromDrag?: boolean } = {},
    ) => {
      const current = stateRef.current;
      if (current.animating) return false;
      endHover();
      const track = trackRef.current;
      if (prefersReducedMotion() || (shift === 0 && !options.fromDrag)) {
        flushSync(() => setState(commitMove(beginMove(current, shift))));
        track?.style.removeProperty("--slider-drag");
        return true;
      }
      if (track && options.durationMs) {
        track.style.setProperty("--slider-duration", `${Math.round(options.durationMs)}ms`);
      }
      if (track && options.momentum)
        track.style.setProperty("--slider-ease", "var(--ease-momentum)");
      // Enable the transition, set the target and drop any drag offset in one style change, so
      // the track animates continuously from where the finger left it.
      flushSync(() => setState(beginMove(current, shift)));
      track?.style.removeProperty("--slider-drag");
      const fallback = (options.durationMs ?? (readCssTime("--duration-slower") || 700)) + 120;
      settleTimer.current = setTimeout(settle, fallback);
      return true;
    },
    [endHover, settle, stateRef],
  );

  const next = useCallback(() => {
    if (!pageable) return;
    const current = stateRef.current;
    // While more items can load, do not wrap past the loaded end; the fetch is already running.
    if (hasMore && mod(current.start, count) + perPage >= count) return;
    move(nextShift(current.start, count, perPage));
  }, [pageable, hasMore, count, perPage, move, stateRef]);

  const prev = useCallback(() => {
    if (!pageable || !stateRef.current.wrapped) return;
    move(prevShift(stateRef.current.start, count, perPage));
  }, [pageable, count, perPage, move, stateRef]);

  const goToPage = useCallback(
    (target: number) => {
      if (!pageable) return;
      const shift = shiftToPage(stateRef.current.start, count, perPage, target);
      if (shift !== 0) move(shift);
    },
    [pageable, count, perPage, move, stateRef],
  );

  const onTransitionEnd = (event: TransitionEvent<HTMLUListElement>) => {
    if (event.target === trackRef.current && event.propertyName === "transform") settle();
  };

  // After a committed move: announce, report, move keyboard focus, keep the roving stop visible.
  // Layout effect: the previously focused card may just have become inert, so focus must land
  // on its successor before the browser paints.
  const lastStart = useRef(state.start);
  useLayoutEffect(() => {
    if (state.animating || state.start === lastStart.current) return;
    lastStart.current = state.start;
    if (!pageable) return;
    const first = mod(state.start, count) + 1;
    const last = Math.min(first + perPage - 1, count);
    setAnnouncement(`Showing ${first} to ${last} of ${count}`);
    callbacks.current.onPageChange?.(currentPage(state.start, count, perPage), pages);
    const target = pendingFocus.current;
    pendingFocus.current = null;
    setActiveVirtual(target ?? state.start);
    if (target !== null) focusVirtual(target);
  });

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  function focusVirtual(virtual: number) {
    const cell = trackRef.current?.querySelector<HTMLElement>(`[data-virtual="${virtual}"]`);
    const target = cell?.querySelector<HTMLElement>("[data-slider-focus]");
    target?.focus({ preventScroll: true });
    if (mode === "scroll") target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ---- Keyboard: one Tab stop per row, arrows inside ----------------------------------------
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-virtual]");
    if (!cell) return;
    const virtual = Number(cell.dataset.virtual);
    const current = stateRef.current;
    const lastVisible = current.start + perPage - 1;
    const key = event.key;
    if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
    event.preventDefault();

    if (mode === "scroll" || !pageable) {
      const index = mod(virtual, count);
      const target =
        key === "ArrowRight"
          ? Math.min(index + 1, count - 1)
          : key === "ArrowLeft"
            ? Math.max(index - 1, 0)
            : key === "Home"
              ? 0
              : count - 1;
      setActiveVirtual(target);
      focusVirtual(target);
      return;
    }
    if (current.animating) return;
    if (key === "Home") return focusAndActivate(current.start);
    if (key === "End") return focusAndActivate(lastVisible);
    if (key === "ArrowRight") {
      if (virtual < lastVisible) return focusAndActivate(virtual + 1);
      const shift = nextShift(current.start, count, perPage);
      if (hasMore && mod(current.start, count) + perPage >= count) return;
      pendingFocus.current = current.start + shift;
      move(shift);
      return;
    }
    if (virtual > current.start) return focusAndActivate(virtual - 1);
    if (!current.wrapped) return;
    const shift = prevShift(current.start, count, perPage);
    pendingFocus.current = current.start + shift + perPage - 1;
    move(shift);
  };

  function focusAndActivate(virtual: number) {
    setActiveVirtual(virtual);
    focusVirtual(virtual);
  }

  // ---- Touch / pen swipe with momentum (paged mode) -----------------------------------------
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!pageable || event.pointerType === "mouse" || stateRef.current.animating) return;
    drag.current = {
      pointerId: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      decided: null,
      dx: 0,
      samples: [{ x: event.clientX, t: event.timeStamp }],
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x0;
    const dy = event.clientY - current.y0;
    if (current.decided === null) {
      if (Math.abs(dy) > DRAG_THRESHOLD_PX && Math.abs(dy) > Math.abs(dx)) {
        current.decided = "scroll";
        drag.current = null;
        return;
      }
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      current.decided = "drag";
      endHover();
      capturePointer(viewportRef.current, event.pointerId, true);
      trackRef.current?.setAttribute("data-dragging", "");
    }
    // Rubber-band before the first move (there is nothing to the left yet).
    const resisted = !stateRef.current.wrapped && dx > 0 ? dx * 0.3 : dx;
    current.dx = resisted;
    current.samples.push({ x: event.clientX, t: event.timeStamp });
    if (current.samples.length > 5) current.samples.shift();
    trackRef.current?.style.setProperty("--slider-drag", `${resisted}px`);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    drag.current = null;
    if (current?.decided !== "drag") return;
    suppressClick.current = true;
    trackRef.current?.removeAttribute("data-dragging");
    capturePointer(viewportRef.current, event.pointerId, false);

    const first = current.samples[0];
    const last = current.samples[current.samples.length - 1];
    const velocity =
      first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
    const itemWidth = (trackRef.current?.getBoundingClientRect().width ?? 600) / perPage;
    const pageWidth = itemWidth * perPage;
    const distanceThreshold = Math.min(itemWidth * 0.5, 96);
    const state = stateRef.current;

    let shift = 0;
    if (current.dx < -distanceThreshold || velocity < -FLICK_VELOCITY) {
      if (!(hasMore && mod(state.start, count) + perPage >= count)) {
        shift = nextShift(state.start, count, perPage);
      }
    } else if ((current.dx > distanceThreshold || velocity > FLICK_VELOCITY) && state.wrapped) {
      shift = prevShift(state.start, count, perPage);
    }
    // Momentum: continue at the release speed, decelerating into place.
    const remaining = Math.abs(shift * itemWidth + current.dx);
    const speed = Math.max(Math.abs(velocity), 0.6);
    const durationMs = Math.min(650, Math.max(220, remaining / speed));
    if (shift === 0) {
      move(0, {
        durationMs: Math.min(380, Math.max(200, Math.abs(current.dx) * 1.5)),
        fromDrag: true,
      });
    } else {
      move(shift, {
        durationMs: Math.min(durationMs, (pageWidth / speed) * 1.2),
        momentum: true,
        fromDrag: true,
      });
    }
  };

  const onClickCapture = (event: MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // ---- Hover intent ---------------------------------------------------------------------------
  const startIntent = (element: HTMLLIElement, item: T, index: number, virtual: number) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      const current = stateRef.current;
      if (current.animating || drag.current) return;
      if (mode === "paged" && pageable && !isVisible(virtual, current, perPage)) return;
      const accepted = callbacks.current.onItemHoverIntent?.({
        item,
        index,
        element,
        rect: element.getBoundingClientRect(),
        edge: mode === "paged" && pageable ? edgeOf(virtual, current, perPage) : null,
        position: mode === "paged" && pageable ? virtual - current.start : index,
        perPage,
      });
      // A declined intent leaves the item un-hovered, so moving on it can ask again.
      if (accepted !== false) hovered.current = { item, index };
    }, resolveHoverDelay(hoverIntentDelay));
  };

  const onCellPointerEnter = (
    event: PointerEvent<HTMLLIElement>,
    item: T,
    index: number,
    virtual: number,
  ) => {
    if (event.pointerType !== "mouse" || !callbacks.current.onItemHoverIntent) return;
    startIntent(event.currentTarget, item, index, virtual);
  };

  // Movement on a card restarts intent when nothing is pending: a card that slid under a resting
  // pointer (page scroll, paging) gets its preview once the pointer moves, like a fresh entry.
  const onCellPointerMove = (
    event: PointerEvent<HTMLLIElement>,
    item: T,
    index: number,
    virtual: number,
  ) => {
    if (event.pointerType !== "mouse" || !callbacks.current.onItemHoverIntent) return;
    if (hoverTimer.current || hovered.current?.index === index) return;
    startIntent(event.currentTarget, item, index, virtual);
  };

  const onCellPointerLeave = (event: PointerEvent<HTMLLIElement>, item: T, index: number) => {
    if (event.pointerType !== "mouse") return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (hovered.current?.index === index) {
      hovered.current = null;
      callbacks.current.onItemHoverEnd?.({ item, index });
    }
  };

  // ---- Scroll mode: ask for more near the end -----------------------------------------------
  const onScroll = () => {
    if (mode !== "scroll" || !hasMore) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (
      viewport.scrollLeft + viewport.clientWidth * 2.5 >= viewport.scrollWidth &&
      requestedAt.current !== count
    ) {
      requestedAt.current = count;
      callbacks.current.onEndReached?.();
    }
  };

  // ---- Imperative handle -------------------------------------------------------------------
  useImperativeHandle(
    ref,
    () => ({
      next,
      prev,
      goToPage,
      getItemElement: (index: number) => {
        const cells = trackRef.current?.querySelectorAll<HTMLElement>(`[data-index="${index}"]`);
        return Array.from(cells ?? []).find((cell) => !cell.hasAttribute("inert")) ?? null;
      },
      getVisibleIndices: () => {
        if (!pageable) return items.map((_, index) => index);
        const current = stateRef.current;
        return Array.from({ length: Math.min(perPage, count) }, (_, offset) =>
          mod(current.start + offset, count),
        );
      },
      isAnimating: () => stateRef.current.animating,
      getMode: () => mode,
    }),
    [next, prev, goToPage, pageable, items, perPage, count, mode, stateRef],
  );

  // ---- Render ----------------------------------------------------------------------------------
  const { from, to } = pageable ? renderWindow(state, count, perPage) : { from: 0, to: count };
  const offset = pageable ? trackOffset(state, count, perPage) : 0;
  const rovingStop = pageable
    ? isVisible(activeVirtual, state, perPage)
      ? activeVirtual
      : state.start
    : Math.min(Math.max(activeVirtual, 0), Math.max(count - 1, 0));

  const cells: ReactNode[] = [];
  for (let virtual = from; virtual < to; virtual += 1) {
    const index = mod(virtual, count);
    const item = items[index];
    if (item === undefined) continue;
    const visible = !pageable || isVisible(virtual, state, perPage);
    const key = `${getKey(item)}@${Math.floor(virtual / Math.max(count, 1))}`;
    cells.push(
      <li
        key={key}
        className="wf-slider__item"
        data-index={index}
        data-virtual={virtual}
        inert={!visible}
        aria-setsize={count}
        aria-posinset={index + 1}
        onPointerEnter={(event) => onCellPointerEnter(event, item, index, virtual)}
        onPointerMove={(event) => onCellPointerMove(event, item, index, virtual)}
        onPointerLeave={(event) => onCellPointerLeave(event, item, index)}
        onFocus={() => setActiveVirtual(virtual)}
      >
        {renderItem(item, {
          index,
          visible,
          edge: pageable ? edgeOf(virtual, state, perPage) : null,
          focusProps: { tabIndex: virtual === rovingStop ? 0 : -1, "data-slider-focus": "" },
        })}
      </li>,
    );
  }

  const Heading = headingLevel === 2 ? "h2" : "h3";
  const trackStyle = { "--slider-offset": offset } as CSSProperties;

  return (
    <section
      ref={rootRef}
      id={baseId}
      className={cx("wf-slider", className)}
      data-mode={mode}
      data-layout={layout}
      data-state={state.animating ? "moving" : "idle"}
      aria-roledescription="carousel"
      aria-labelledby={headingId}
    >
      <div className="wf-slider__header">
        <div className="flex min-w-0 items-baseline gap-4">
          <Heading id={headingId} className="type-row-title truncate text-fg">
            {title}
          </Heading>
          {headerAction}
        </div>
        {pageable && pages > 1 ? (
          <div
            className="wf-slider__pages"
            aria-hidden
            data-force-visible={forceControls || undefined}
          >
            {Array.from({ length: pages }, (_, index) => (
              <span
                key={index}
                className="wf-slider__page"
                data-active={index === page || undefined}
              />
            ))}
          </div>
        ) : null}
      </div>

      <div
        ref={viewportRef}
        className="wf-slider__viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
        onScroll={onScroll}
      >
        {pageable && state.wrapped ? (
          <button
            type="button"
            className="wf-slider__handle"
            data-side="start"
            aria-label="Previous titles"
            aria-controls={trackId}
            data-force-visible={forceControls || undefined}
            onClick={prev}
          >
            <ChevronLeftIcon size="inherit" />
          </button>
        ) : null}
        <ul
          ref={trackRef}
          id={trackId}
          // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics when list-style is none.
          role="list"
          className="wf-slider__track"
          style={trackStyle}
          data-animating={state.animating || undefined}
          onTransitionEnd={onTransitionEnd}
          onKeyDown={onKeyDown}
        >
          {cells}
        </ul>
        {pageable ? (
          <button
            type="button"
            className="wf-slider__handle"
            data-side="end"
            aria-label="More titles"
            aria-controls={trackId}
            data-force-visible={forceControls || undefined}
            onClick={next}
          >
            <ChevronRightIcon size="inherit" />
          </button>
        ) : null}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic>
        {announcement}
      </div>
    </section>
  );
}
