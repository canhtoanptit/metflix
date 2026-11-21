import { type HistoryState, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";
import { searchParam } from "../router/search.ts";

/**
 * The URL-driven overlay convention used by the title detail modal.
 *
 * - `?title=<titleId>` on any signed-in (profile) route opens the detail overlay above that page.
 *   The URL is shareable; a reload reopens it; `/title/<id>` redirects to `/browse?title=<id>`.
 * - Opening pushes a history entry (Back closes it) without scrolling the page underneath.
 * - Closing pops that entry when we pushed it, or replaces the URL when the page was loaded
 *   with the overlay already open (a shared link), so Back never leaves the app unexpectedly.
 * - Opening another title from inside the overlay stacks: Back returns to the previous one.
 *
 * The browse shell renders the overlay when `useTitleOverlay().titleId` is set.
 */
export const TITLE_OVERLAY_PARAM = "title";

export interface TitleOverlaySearch {
  title?: string;
}

export function validateTitleOverlaySearch(search: Record<string, unknown>): TitleOverlaySearch {
  const title = searchParam.string(search[TITLE_OVERLAY_PARAM]);
  return title ? { title } : {};
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Set on the entry pushed by `open()`, so `close()` knows it may go back. */
    titleOverlay?: boolean;
  }
}

let origin: DOMRect | null = null;

/** Where the overlay was opened from (the card's rect), for a grow-from-card animation. */
export function getTitleOverlayOrigin(): DOMRect | null {
  return origin;
}

export function setTitleOverlayOrigin(rect: DOMRect | null): void {
  origin = rect;
}

export interface TitleOverlayControls {
  /** The open title, if any. */
  titleId: string | undefined;
  open: (titleId: string, options?: { origin?: Element | DOMRect | null }) => void;
  close: () => void;
}

export function useTitleOverlay(): TitleOverlayControls {
  const navigate = useNavigate();
  const router = useRouter();
  const titleId = useRouterState({
    select: (state) =>
      searchParam.string((state.location.search as Record<string, unknown>)[TITLE_OVERLAY_PARAM]),
  });

  const open = useCallback(
    (id: string, options: { origin?: Element | DOMRect | null } = {}) => {
      const from = options.origin;
      setTitleOverlayOrigin(
        from instanceof Element ? from.getBoundingClientRect() : (from ?? null),
      );
      void navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => ({ ...previous, [TITLE_OVERLAY_PARAM]: id }),
        state: (previous) => ({ ...previous, titleOverlay: true }),
        resetScroll: false,
      });
    },
    [navigate],
  );

  const close = useCallback(() => {
    if (router.state.location.state.titleOverlay) {
      router.history.back();
      return;
    }
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => {
        const { [TITLE_OVERLAY_PARAM]: _removed, ...rest } = previous;
        return rest;
      },
      replace: true,
      resetScroll: false,
    });
  }, [navigate, router]);

  return { titleId, open, close };
}

/**
 * Props for a router `<Link>` (or a `createLink` component such as `TitleTileLink`) that opens
 * the overlay: a real `href` (open in new tab works), no scroll jump, origin captured on click.
 */
export function titleOverlayLinkProps(titleId: string) {
  return {
    to: "." as const,
    search: (previous: Record<string, unknown>) => ({
      ...previous,
      [TITLE_OVERLAY_PARAM]: titleId,
    }),
    state: (previous: HistoryState): HistoryState => ({ ...previous, titleOverlay: true }),
    resetScroll: false,
    onClick: (event: { currentTarget: Element }) => {
      setTitleOverlayOrigin(event.currentTarget.getBoundingClientRect());
    },
  };
}
