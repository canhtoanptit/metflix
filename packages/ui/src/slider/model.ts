/**
 * Pure paging model of the row slider. Positions are *virtual* indices: unbounded integers that
 * map onto the item list modulo its length, so the row can wrap around forever while React keys
 * stay stable (`<item key>@<cycle>`). Everything here is deterministic and unit-tested; the
 * component only adds DOM, timing and input handling.
 */

export interface SliderState {
  /** Virtual index of the first fully visible item. */
  start: number;
  /** True after the first move: the previous page renders on the left and Previous is offered. */
  wrapped: boolean;
  /** Items the track is animating by (signed); 0 when idle. */
  shift: number;
  animating: boolean;
}

export const INITIAL_SLIDER_STATE: SliderState = {
  start: 0,
  wrapped: false,
  shift: 0,
  animating: false,
};

export function mod(index: number, length: number): number {
  return length === 0 ? 0 : ((index % length) + length) % length;
}

export function canPage(count: number, perPage: number): boolean {
  return count > perPage;
}

export function pageCount(count: number, perPage: number): number {
  return Math.max(1, Math.ceil(count / perPage));
}

/** Zero-based page shown when the first visible item is `start`. */
export function currentPage(start: number, count: number, perPage: number): number {
  return Math.floor(mod(start, count) / perPage);
}

/** Items to move for "next": a full page, or the remainder of the last page before wrapping. */
export function nextShift(start: number, count: number, perPage: number): number {
  const offset = mod(start, count);
  const lastPageStart = (pageCount(count, perPage) - 1) * perPage;
  return offset >= lastPageStart ? count - offset : perPage;
}

/** Items to move for "previous" (negative): from the first page it wraps to the last page. */
export function prevShift(start: number, count: number, perPage: number): number {
  const offset = mod(start, count);
  if (offset === 0) return -(count - (pageCount(count, perPage) - 1) * perPage);
  return -Math.min(perPage, offset);
}

/** Shift that lands on page `page` going forward or backward the short way. */
export function shiftToPage(start: number, count: number, perPage: number, page: number): number {
  const target = Math.min(page, pageCount(count, perPage) - 1) * perPage;
  return target - mod(start, count);
}

/**
 * Virtual range to render: the previous page plus one peek on the left (once wrapped), the
 * current page, the next page and one peek on the right. Large enough for any single move.
 */
export function renderWindow(
  state: SliderState,
  count: number,
  perPage: number,
): { from: number; to: number } {
  if (!canPage(count, perPage)) return { from: 0, to: count };
  return {
    from: state.wrapped ? state.start - perPage - 1 : state.start,
    to: state.start + perPage * 2 + 1,
  };
}

/** Track offset in items: how far the window's first item sits to the left of the viewport. */
export function trackOffset(state: SliderState, count: number, perPage: number): number {
  if (!canPage(count, perPage)) return 0;
  const { from } = renderWindow(state, count, perPage);
  return state.start - from + (state.animating ? state.shift : 0);
}

export function isVisible(virtual: number, state: SliderState, perPage: number): boolean {
  return virtual >= state.start && virtual < state.start + perPage;
}

/** Position of a visible item relative to the page edges (hover previews expand inward). */
export function edgeOf(
  virtual: number,
  state: SliderState,
  perPage: number,
): "start" | "end" | null {
  if (!isVisible(virtual, state, perPage)) return null;
  if (virtual === state.start) return "start";
  if (virtual === state.start + perPage - 1) return "end";
  return null;
}

/** Begin a move. Returns the state to render with the transition enabled. */
export function beginMove(state: SliderState, shift: number): SliderState {
  return { ...state, shift, animating: true };
}

/** Finish a move (transition end, or immediately under reduced motion). */
export function commitMove(state: SliderState): SliderState {
  if (state.shift === 0) return { ...state, animating: false };
  return { start: state.start + state.shift, wrapped: true, shift: 0, animating: false };
}

/**
 * Keep the first visible item on a page boundary when the page size or item count changes
 * (resize, more items loaded, an item removed). Preserves the wrap cycle so keys stay stable.
 */
export function realign(state: SliderState, count: number, perPage: number): SliderState {
  if (!canPage(count, perPage) || count === 0) return INITIAL_SLIDER_STATE;
  const cycle = Math.floor(state.start / count);
  const offset = mod(state.start, count);
  const lastPageStart = (pageCount(count, perPage) - 1) * perPage;
  const aligned = Math.min(Math.floor(offset / perPage) * perPage, lastPageStart);
  const start = cycle * count + aligned;
  if (start === state.start && !state.animating) return state;
  return { ...state, start, shift: 0, animating: false };
}

/** Whether the next page would run past the loaded items (time to fetch more). */
export function nearsEnd(state: SliderState, count: number, perPage: number): boolean {
  return mod(state.start, count) + perPage * 2 >= count;
}
