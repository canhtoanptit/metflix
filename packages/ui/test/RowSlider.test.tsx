import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TitleCard } from "@webflix/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RowSlider, type RowSliderProps } from "../src/slider/RowSlider.tsx";
import { TitleTile } from "../src/slider/TitleTile.tsx";
import { expectNoA11yViolations } from "../src/testing/index.ts";
import { titleCards } from "./fixtures.ts";

// jsdom has no layout: the CSS page size cannot be computed, so the slider falls back to 6 per
// page. Reduced motion makes moves commit synchronously (no transitionend in jsdom).
beforeEach(() => {
  document.documentElement.dataset.motion = "reduce";
});
afterEach(() => {
  vi.useRealTimers();
});

function renderRow(count = 14, props: Partial<RowSliderProps<TitleCard>> = {}) {
  const items = titleCards(count);
  render(
    <RowSlider<TitleCard>
      title="Trending Now"
      items={items}
      getKey={(item) => item.id}
      renderItem={(item, { focusProps }) => (
        <TitleTile title={item} layout="standard" href={`#${item.id}`} {...focusProps} />
      )}
      {...props}
    />,
  );
  return items;
}

const visibleNames = () =>
  screen
    .getAllByRole("listitem")
    .filter((item) => !item.hasAttribute("inert"))
    .map((item) => item.textContent);

describe("RowSlider", () => {
  it("is a labelled carousel with one page visible and the rest inert", async () => {
    renderRow();
    const region = screen.getByRole("region", { name: "Trending Now" });
    expect(region).toHaveAttribute("aria-roledescription", "carousel");
    expect(visibleNames()).toEqual([
      "Title 1",
      "Title 2",
      "Title 3",
      "Title 4",
      "Title 5",
      "Title 6",
    ]);
    // No previous arrow until the first move (blueprint: wrap-around after the first page).
    expect(screen.queryByRole("button", { name: "Previous titles" })).toBeNull();
    await expectNoA11yViolations(document.body);
  });

  it("pages with the arrows, wraps around and announces the page", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    renderRow(14, { onPageChange });
    await user.click(screen.getByRole("button", { name: "More titles" }));
    expect(visibleNames()[0]).toBe("Title 7");
    expect(onPageChange).toHaveBeenLastCalledWith(1, 3);
    expect(screen.getByText("Showing 7 to 12 of 14")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous titles" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More titles" }));
    expect(visibleNames().slice(0, 2)).toEqual(["Title 13", "Title 14"]);
    // The last page continues with the first titles, then wraps to page one.
    expect(visibleNames().slice(2)).toEqual(["Title 1", "Title 2", "Title 3", "Title 4"]);
    await user.click(screen.getByRole("button", { name: "More titles" }));
    expect(visibleNames()[0]).toBe("Title 1");
    expect(onPageChange).toHaveBeenLastCalledWith(0, 3);

    await user.click(screen.getByRole("button", { name: "Previous titles" }));
    expect(visibleNames()[0]).toBe("Title 13");
  });

  it("keeps one Tab stop and moves focus with arrow keys, paging at the edges", async () => {
    const user = userEvent.setup();
    renderRow();
    const links = () => screen.getAllByRole("link");
    expect(links().filter((link) => link.tabIndex === 0)).toHaveLength(1);

    await user.tab();
    expect(document.activeElement).toHaveAccessibleName(/Title 1/);
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(document.activeElement).toHaveAccessibleName(/Title 3/);
    await user.keyboard("{End}");
    expect(document.activeElement).toHaveAccessibleName(/Title 6/);
    // Past the last visible card: the row pages and focus lands on the next page's first card.
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toHaveAccessibleName(/Title 7/);
    expect(visibleNames()[0]).toBe("Title 7");
    // And back.
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toHaveAccessibleName(/Title 6/);
    expect(visibleNames()[0]).toBe("Title 1");
  });

  it("does not page when everything fits", () => {
    renderRow(4);
    expect(screen.queryByRole("button", { name: "More titles" })).toBeNull();
    expect(visibleNames()).toHaveLength(4);
  });

  it("only renders a window of items (lazy rendering)", () => {
    renderRow(60);
    // Current page + next page + one peek = 13 cells, not 60.
    expect(screen.getAllByRole("listitem")).toHaveLength(13);
  });

  it("reports hover intent with geometry and edge after the delay, mouse only", () => {
    vi.useFakeTimers();
    const onItemHoverIntent = vi.fn();
    const onItemHoverEnd = vi.fn();
    renderRow(14, { onItemHoverIntent, onItemHoverEnd, hoverIntentDelay: 400 });
    const cells = screen.getAllByRole("listitem");
    const first = cells[0] as HTMLElement;
    const third = cells[2] as HTMLElement;

    fireEvent.pointerEnter(first, { pointerType: "touch" });
    act(() => vi.advanceTimersByTime(500));
    expect(onItemHoverIntent).not.toHaveBeenCalled();

    fireEvent.pointerEnter(first, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(399));
    expect(onItemHoverIntent).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onItemHoverIntent).toHaveBeenCalledTimes(1);
    expect(onItemHoverIntent.mock.calls[0]?.[0]).toMatchObject({
      index: 0,
      edge: "start",
      position: 0,
      perPage: 6,
      element: first,
    });
    fireEvent.pointerLeave(first, { pointerType: "mouse" });
    expect(onItemHoverEnd).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));

    // Leaving before the delay cancels.
    fireEvent.pointerEnter(third, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.pointerLeave(third, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(400));
    expect(onItemHoverIntent).toHaveBeenCalledTimes(1);
  });

  it("reads the hover-intent token in its unit (production CSS ships 450ms as .45s)", () => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty("--delay-hover-intent", ".45s");
    try {
      const onItemHoverIntent = vi.fn();
      renderRow(14, { onItemHoverIntent });
      fireEvent.pointerEnter(screen.getAllByRole("listitem")[1] as HTMLElement, {
        pointerType: "mouse",
      });
      act(() => vi.advanceTimersByTime(100));
      expect(onItemHoverIntent).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(350));
      expect(onItemHoverIntent).toHaveBeenCalledTimes(1);
    } finally {
      document.documentElement.style.removeProperty("--delay-hover-intent");
    }
  });

  it("a declined intent leaves the card un-hovered: moving on it asks again", () => {
    vi.useFakeTimers();
    // Declined once (say the page had just scrolled), then accepted.
    const onItemHoverIntent = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    renderRow(14, { onItemHoverIntent, hoverIntentDelay: 400 });
    const card = screen.getAllByRole("listitem")[2] as HTMLElement;

    fireEvent.pointerEnter(card, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(400));
    expect(onItemHoverIntent).toHaveBeenCalledTimes(1);

    fireEvent.pointerMove(card, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(400));
    expect(onItemHoverIntent).toHaveBeenCalledTimes(2);

    // Accepted: the card is hovered now, and moving on it does not ask again.
    fireEvent.pointerMove(card, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(1000));
    expect(onItemHoverIntent).toHaveBeenCalledTimes(2);
  });

  it("keeps a page move going for the whole --duration-slower, in either unit", async () => {
    vi.useFakeTimers();
    // Full motion; jsdom fires no transitionend, so only the fallback timer settles the move.
    document.documentElement.dataset.motion = "full";
    document.documentElement.style.setProperty("--duration-slower", ".7s");
    try {
      renderRow(14);
      const region = screen.getByRole("region", { name: "Trending Now" });
      fireEvent.click(screen.getByRole("button", { name: "More titles" }));
      expect(region).toHaveAttribute("data-state", "moving");
      act(() => vi.advanceTimersByTime(600));
      expect(region).toHaveAttribute("data-state", "moving");
      act(() => vi.advanceTimersByTime(300));
      expect(region).toHaveAttribute("data-state", "idle");
      expect(visibleNames()[0]).toBe("Title 7");
    } finally {
      document.documentElement.style.removeProperty("--duration-slower");
    }
  });

  it("asks for more items near the loaded end and does not wrap while more can load", async () => {
    const user = userEvent.setup();
    const onEndReached = vi.fn();
    renderRow(12, { hasMore: true, onEndReached });
    expect(onEndReached).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "More titles" }));
    expect(visibleNames()[0]).toBe("Title 7");
    // On the last loaded page: next waits for the fetch instead of wrapping.
    await user.click(screen.getByRole("button", { name: "More titles" }));
    expect(visibleNames()[0]).toBe("Title 7");
  });

  it("becomes a native scrolling row on touch-first devices", async () => {
    renderRow(14, { mode: "scroll" });
    const region = screen.getByRole("region", { name: "Trending Now" });
    expect(region).toHaveAttribute("data-mode", "scroll");
    expect(within(region).queryByRole("button")).toBeNull();
    expect(within(region).getAllByRole("listitem")).toHaveLength(14);
  });
});
