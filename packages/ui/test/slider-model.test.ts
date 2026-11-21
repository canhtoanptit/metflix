import { describe, expect, it } from "vitest";
import {
  beginMove,
  commitMove,
  currentPage,
  edgeOf,
  INITIAL_SLIDER_STATE,
  nearsEnd,
  nextShift,
  pageCount,
  prevShift,
  realign,
  renderWindow,
  type SliderState,
  shiftToPage,
  trackOffset,
} from "../src/slider/model.ts";

const move = (state: SliderState, shift: number) => commitMove(beginMove(state, shift));

describe("slider model", () => {
  it("pages forward by a full page, then wraps to the start after the last page", () => {
    // 10 items, 4 per page: pages start at 0, 4, 8 (last page holds 2).
    let state = INITIAL_SLIDER_STATE;
    expect(pageCount(10, 4)).toBe(3);
    expect(nextShift(state.start, 10, 4)).toBe(4);
    state = move(state, nextShift(state.start, 10, 4));
    expect(state).toMatchObject({ start: 4, wrapped: true });
    state = move(state, nextShift(state.start, 10, 4));
    expect(state.start).toBe(8);
    expect(currentPage(state.start, 10, 4)).toBe(2);
    // From the short last page the move is only the remainder, landing on item 0 again.
    expect(nextShift(state.start, 10, 4)).toBe(2);
    state = move(state, 2);
    expect(state.start).toBe(10);
    expect(currentPage(state.start, 10, 4)).toBe(0);
  });

  it("pages backward and wraps from the first page to the last", () => {
    expect(prevShift(0, 10, 4)).toBe(-2);
    expect(prevShift(8, 10, 4)).toBe(-4);
    expect(prevShift(4, 10, 4)).toBe(-4);
  });

  it("renders no left side until the first move, then one page plus a peek on both sides", () => {
    expect(renderWindow(INITIAL_SLIDER_STATE, 20, 5)).toEqual({ from: 0, to: 11 });
    const moved = move(INITIAL_SLIDER_STATE, 5);
    expect(renderWindow(moved, 20, 5)).toEqual({ from: -1, to: 16 });
    expect(trackOffset(moved, 20, 5)).toBe(6);
  });

  it("offsets the track by the pending shift while animating", () => {
    const animating = beginMove(INITIAL_SLIDER_STATE, 5);
    expect(trackOffset(animating, 20, 5)).toBe(5);
    expect(trackOffset(INITIAL_SLIDER_STATE, 20, 5)).toBe(0);
  });

  it("does not page when everything fits", () => {
    expect(renderWindow(INITIAL_SLIDER_STATE, 4, 6)).toEqual({ from: 0, to: 4 });
    expect(trackOffset(INITIAL_SLIDER_STATE, 4, 6)).toBe(0);
  });

  it("reports page edges for inward-expanding previews", () => {
    const state = { ...INITIAL_SLIDER_STATE, start: 6 };
    expect(edgeOf(6, state, 6)).toBe("start");
    expect(edgeOf(11, state, 6)).toBe("end");
    expect(edgeOf(8, state, 6)).toBeNull();
    expect(edgeOf(12, state, 6)).toBeNull();
  });

  it("realigns to a page boundary on resize, keeping the wrap cycle", () => {
    const state: SliderState = { start: 23, wrapped: true, shift: 0, animating: false };
    // count 20 → cycle 1, offset 3; with 4 per page the boundary is 0 → start 20.
    expect(realign(state, 20, 4).start).toBe(20);
    // A page size that fits everything resets the slider.
    expect(realign(state, 20, 30)).toEqual(INITIAL_SLIDER_STATE);
  });

  it("computes shifts to arbitrary pages and asks for more near the end", () => {
    expect(shiftToPage(0, 20, 5, 2)).toBe(10);
    expect(shiftToPage(15, 20, 5, 0)).toBe(-15);
    expect(nearsEnd({ ...INITIAL_SLIDER_STATE, start: 10 }, 20, 5)).toBe(true);
    expect(nearsEnd(INITIAL_SLIDER_STATE, 20, 5)).toBe(false);
  });
});
