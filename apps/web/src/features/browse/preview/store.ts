import type { EpisodeRef, Progress, RowLayout, TitleCard } from "@webflix/contracts";
import { useSyncExternalStore } from "react";
import type { TelemetryContext } from "../../../app/telemetry/index.ts";

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
  /**
   * Artwork already decoded when the preview opened (the card's own image, or the preview-width
   * image fetched during hover intent): painted on the first frame, synchronously. Null: none
   * was ready in time, and the preview loads its artwork itself.
   */
  art?: string | null;
  /** Where the card sits (surface, row, positions, policy): what the preview reports with. */
  context?: TelemetryContext | null;
  /** Called when the card is opened from the preview (details or Play). */
  onOpen?: () => void;
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
/** An accepted intent waiting (briefly) for its artwork to decode before the preview opens. */
let pending: { id: string; scope: string; cancel: () => void } | null = null;
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

function cancelPending(match?: (waiting: { id: string; scope: string }) => boolean) {
  if (!pending || (match && !match(pending))) return;
  pending.cancel();
  pending = null;
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
    cancelPending();
    clearLeave();
    pointerOnPreview = false;
    emit({ request });
    return true;
  },
  /**
   * Accept an intent whose artwork is still decoding: open once `ready` settles (or after
   * `maxWaitMs`), building the request then, unless the pointer left the card, the page
   * scrolled or another preview was asked for meanwhile. Same answer as `open` otherwise.
   */
  openWhenReady(
    id: string,
    scope: string,
    ready: Promise<unknown>,
    build: () => PreviewRequest,
    maxWaitMs: number,
  ): boolean {
    if (state.request?.id === id) {
      clearLeave();
      return true;
    }
    if (Date.now() - lastScrollAt < SCROLL_QUIET_MS) return false;
    cancelPending();
    let live = true;
    const go = () => {
      if (!live) return;
      live = false;
      clearTimeout(timer);
      pending = null;
      previewStore.open(build());
    };
    const timer = setTimeout(go, maxWaitMs);
    void ready.then(go, go);
    pending = {
      id,
      scope,
      cancel: () => {
        live = false;
        clearTimeout(timer);
      },
    };
    return true;
  },
  close(options: { warm?: boolean } = {}): void {
    cancelPending();
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
    cancelPending();
    previewStore.close({ warm: false });
  },
  /** Close if the open preview belongs to `scope` (the row paged, the grid changed). */
  closeScope(scope: string): void {
    cancelPending((waiting) => waiting.scope === scope);
    if (state.request?.scope === scope) previewStore.close();
  },
  /** The pointer left the anchor card: close unless it arrives on the preview. */
  anchorLeft(id: string): void {
    cancelPending((waiting) => waiting.id === id);
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
    cancelPending();
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
