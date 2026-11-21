import { makeTitleCard, resetFixtures } from "@webflix/contracts/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PreviewRequest, previewStore } from "../src/features/browse/preview/store.ts";

function request(id: string, scope = "row:a"): PreviewRequest {
  return {
    id,
    scope,
    card: makeTitleCard(),
    anchor: document.createElement("li"),
    rect: new DOMRect(0, 0, 200, 112),
    edge: null,
    layout: "standard",
  };
}

beforeEach(() => {
  resetFixtures();
  vi.useFakeTimers();
  previewStore.reset();
});
afterEach(() => vi.useRealTimers());

describe("hover preview store", () => {
  it("keeps one preview open at a time", () => {
    previewStore.open(request("a"));
    previewStore.open(request("b"));
    expect(previewStore.get().request?.id).toBe("b");
  });

  it("gives the pointer a moment to travel from the card onto the preview", () => {
    previewStore.open(request("a"));
    previewStore.anchorLeft("a");
    vi.advanceTimersByTime(40);
    previewStore.pointerEnteredPreview();
    vi.advanceTimersByTime(500);
    expect(previewStore.get().request?.id).toBe("a");
    previewStore.pointerLeftPreview();
    expect(previewStore.get().request).toBeNull();
  });

  it("closes when the pointer leaves the card for somewhere else", () => {
    previewStore.open(request("a"));
    previewStore.anchorLeft("a");
    vi.advanceTimersByTime(200);
    expect(previewStore.get().request).toBeNull();
  });

  it("ignores leave events from other cards", () => {
    previewStore.open(request("a"));
    previewStore.anchorLeft("b");
    vi.advanceTimersByTime(200);
    expect(previewStore.get().request?.id).toBe("a");
  });

  it("closes only the scope that paged", () => {
    previewStore.open(request("a", "row:one"));
    previewStore.closeScope("row:two");
    expect(previewStore.get().request).not.toBeNull();
    previewStore.closeScope("row:one");
    expect(previewStore.get().request).toBeNull();
  });

  it("hands off quickly to the next card after moving along a row, not after a dismissal", () => {
    expect(previewStore.intentDelay()).toBeUndefined();
    previewStore.open(request("a"));
    previewStore.close();
    expect(previewStore.intentDelay()).toBeLessThan(450);
    vi.advanceTimersByTime(1000);
    expect(previewStore.intentDelay()).toBeUndefined();
    previewStore.open(request("b"));
    previewStore.close({ warm: false });
    expect(previewStore.intentDelay()).toBeUndefined();
  });

  it("does not open previews while the page is scrolling, nor from an intent begun during it", () => {
    previewStore.noteScroll();
    previewStore.open(request("a"));
    expect(previewStore.get().request).toBeNull();
    // An intent timer that started as the page scrolled fires within the quiet window.
    vi.advanceTimersByTime(450);
    previewStore.open(request("a"));
    expect(previewStore.get().request).toBeNull();
    vi.advanceTimersByTime(100);
    previewStore.open(request("a"));
    expect(previewStore.get().request?.id).toBe("a");
  });

  it("says whether it opened, so a declined card can ask again on the next movement", () => {
    previewStore.noteScroll();
    expect(previewStore.open(request("a"))).toBe(false);
    vi.advanceTimersByTime(600);
    expect(previewStore.open(request("a"))).toBe(true);
    expect(previewStore.open(request("a"))).toBe(true);
  });

  it("a declined request does not keep the previous preview open", () => {
    previewStore.open(request("a"));
    // The pointer leaves card a for card b while the page scrolls a little.
    previewStore.anchorLeft("a");
    previewStore.noteScroll();
    expect(previewStore.open(request("b"))).toBe(false);
    vi.advanceTimersByTime(200);
    expect(previewStore.get().request).toBeNull();
  });
});
