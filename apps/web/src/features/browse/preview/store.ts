import type { EpisodeRef, Progress, RowLayout, TitleCard } from "@webflix/contracts";
import { useSyncExternalStore } from "react";

/**
 * One hover preview at a time, for the whole signed-in shell. Rows and grids *request* a
 * preview after hover intent; the shell renders it in a portal (outside every row's clip);
 * the billboard pauses while one is open. Pure state + timers, no React rendering here, so the
 * store sits in the browse chunk while the preview UI loads lazily.
 */

export interface PreviewRequest {
  /** Unique per anchor (`<scope>:<title id>:<index>`). */
  id: string;
  /** The row or grid it came from: paging or re-rendering that scope closes it. */
  scope: string;
  card: TitleCard;
  /** The card's cell; the preview grows from (and shrinks back into) the card inside it. */
  anchor: HTMLElement;
  /** Where the hover started (card rect, viewport coordinates). */
  rect: DOMRect;
  /** First/last visible card of a row: expand inward from that side. */
  edge: "start" | "end" | null;
  layout: RowLayout;
  /** Ranked rows: "#2 in Series Today". */
  rankLabel?: string | null;
  /** Continue Watching: resume point, and the "remove from row" action. */
  progress?: Progress | null;
  episode?: EpisodeRef | null;
  removable?: boolean;
}

interface State {
  request: PreviewRequest | null;
}

/** Grace for the pointer to travel from the card onto the preview (they overlap, so it is short). */
const LEAVE_GRACE_MS = 90;
/** After a preview closes, the next card opens faster for this long (moving along a row). */
const WARM_WINDOW_MS = 700;
const WARM_DELAY_MS = 220;

let state: State = { request: null };
const listeners = new Set<() => void>();
let leaveTimer: ReturnType<typeof setTimeout> | null = null;
let pointerOnPreview = false;
let lastClosedAt = 0;
let lastScrollAt = 0;
/**
 * Previews never open from a scroll: cards slide under a resting pointer, and an intent that
 * began during scrolling would fire just after it. Longer than the intent delay, so only
 * pointer movement after the page settles opens one.
 */
const SCROLL_QUIET_MS = 500;

function emit(next: State) {
  state = next;
  for (const listener of listeners) listener();
}

function clearLeave() {
  if (leaveTimer) clearTimeout(leaveTimer);
  leaveTimer = null;
}

export const previewStore = {
  get: (): State => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /**
   * Show `request`. Returns false when declined (the page scrolled moments ago): the caller
   * must not treat the card as hovered, so the next pointer movement on it asks again. A
   * declined request leaves any open preview's pending close alone.
   */
  open(request: PreviewRequest): boolean {
    if (state.request?.id === request.id) {
      clearLeave();
      return true;
    }
    if (Date.now() - lastScrollAt < SCROLL_QUIET_MS) return false;
    clearLeave();
    pointerOnPreview = false;
    emit({ request });
    return true;
  },
  close(options: { warm?: boolean } = {}): void {
    clearLeave();
    pointerOnPreview = false;
    if (!state.request) return;
    // Moving along a row keeps the next preview quick; dismissals (scroll, Escape) do not.
    lastClosedAt = options.warm === false ? 0 : Date.now();
    emit({ request: null });
  },
  /** The page is scrolling: hold off new previews until it settles. */
  noteScroll(): void {
    lastScrollAt = Date.now();
  },
  /** The page scrolled away from an open preview: close it (no warm hand-off). */
  scrolled(): void {
    lastScrollAt = Date.now();
    previewStore.close({ warm: false });
  },
  /** Close if the open preview belongs to `scope` (the row paged, the grid changed). */
  closeScope(scope: string): void {
    if (state.request?.scope === scope) previewStore.close();
  },
  /** The pointer left the anchor card: close unless it arrives on the preview. */
  anchorLeft(id: string): void {
    if (state.request?.id !== id || pointerOnPreview) return;
    clearLeave();
    leaveTimer = setTimeout(() => {
      leaveTimer = null;
      if (!pointerOnPreview) previewStore.close();
    }, LEAVE_GRACE_MS);
  },
  pointerEnteredPreview(): void {
    pointerOnPreview = true;
    clearLeave();
  },
  pointerLeftPreview(): void {
    pointerOnPreview = false;
    previewStore.close();
  },
  /**
   * Hover-intent delay for the next card: the design token normally, shorter right after a
   * preview closed so moving along a row feels continuous instead of restarting the wait.
   */
  intentDelay(): number | undefined {
    return Date.now() - lastClosedAt < WARM_WINDOW_MS ? WARM_DELAY_MS : undefined;
  },
  /** Test hook. */
  reset(): void {
    clearLeave();
    pointerOnPreview = false;
    lastClosedAt = 0;
    lastScrollAt = 0;
    emit({ request: null });
  },
};

export function usePreviewRequest(): PreviewRequest | null {
  return useSyncExternalStore(
    previewStore.subscribe,
    () => state.request,
    () => null,
  );
}

export function usePreviewOpen(): boolean {
  return useSyncExternalStore(
    previewStore.subscribe,
    () => state.request !== null,
    () => false,
  );
}
