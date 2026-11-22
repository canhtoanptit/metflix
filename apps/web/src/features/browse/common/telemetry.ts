import type { BrowseView, RankingPolicy } from "@webflix/contracts";
import type { PreviewPlayerHandle } from "@webflix/player";
import type { RefCallback } from "react";
import { titleOverlayLinkProps } from "../../../app/overlay/titleOverlay.ts";
import {
  type RowViewInput,
  type TelemetryContext,
  track,
  useImpressionRef,
  useRowViewRef,
  useTelemetryScope,
} from "../../../app/telemetry/index.ts";

/**
 * What browse reports, and where it says it happened (docs/BLUEPRINT-M2.md §6.1; the pipeline's
 * reading of each field is in services/recs/README.md, "Dataset rules").
 *
 * Positions describe the page as the member saw it, 1-based: the billboard is module 1 (`rowRank`
 * 1, `rank` 1, `rowId` `{view}:billboard`), the rows follow in the order they are on screen
 * (`rowRank` 2, 3… after a billboard; from 1 on a view without one), and a card's `rank` is its
 * place in its row. A card's impression and the title-open that follows from that card carry the
 * same `rowRank` and `rank`, and the ranking policy of the page (batch) that produced it: the
 * ranker credits an impression only when that exact card was opened.
 *
 * An impression is a card at least half visible for a second, once per appearance: a card that
 * stays on screen counts once however often it re-renders, and one that leaves the screen
 * entirely (scrolled past, paged away) and comes back is a new appearance.
 */

/** Where a card or row sits on its page. */
export interface Placement {
  rowId: string | null;
  rowRank: number | null;
  rank?: number | null;
  /** The ranking policy of the page that produced the card (null: none was sent). */
  policy: RankingPolicy | null;
}

/** The surface a browse view reports as (the views are surfaces of their own). */
export function viewSurface(view: BrowseView): TelemetryContext["surface"] {
  return view;
}

/** The billboard's row id, as the pipeline reads it (`{view}:billboard`). */
export function billboardRowId(view: BrowseView): string {
  return `${view}:billboard`;
}

/** The event context of a placement (null fields stay null: "not on a row", "not ranked"). */
export function placementContext(placement: Placement): TelemetryContext {
  return {
    rowId: placement.rowId,
    rowRank: placement.rowRank,
    rank: placement.rank ?? null,
    policy: placement.policy,
  };
}

/**
 * The full context of a placement on this page: the nearest scope's (surface, policy) under the
 * placement's own. What leaves the page's scope (the preview, the overlay host) carries this.
 */
export function usePlacementContext(placement: Placement): TelemetryContext {
  return { ...useTelemetryScope(), ...placementContext(placement) };
}

// --- Impressions and row views ------------------------------------------------------------------

/**
 * A ref callback that reports a card's impressions at its place (the telemetry module counts one
 * per appearance: half visible for a second, and again only after it left the screen entirely).
 * Pass null to report nothing. The context is merged over the nearest `<TelemetryScope>`.
 */
export function useCardImpression(
  card: { titleId: string; placement: Placement } | null,
): RefCallback<Element> {
  return useImpressionRef(
    card ? { titleId: card.titleId, context: placementContext(card.placement) } : null,
  );
}

/** A ref callback that reports a row's views at its place (one per appearance, as for a card). */
export function useRowView(
  row: (RowViewInput & { placement: Placement }) | null,
): RefCallback<Element> {
  return useRowViewRef(
    row
      ? {
          rowKind: row.rowKind,
          itemCount: row.itemCount,
          context: { ...row.context, ...placementContext({ ...row.placement, rank: null }) },
        }
      : null,
  );
}

// --- Title opens -------------------------------------------------------------------------------

/**
 * The context of the open the member just asked for (a card, the preview, the billboard, a
 * result). The overlay host reports `title.open` with it once the overlay shows that title, so
 * every way of opening a title reports from one place, and a link opened in a new tab (which
 * never opens the overlay here) reports nothing here: that tab reports its own open.
 */
let pendingOpen: { titleId: string; context: TelemetryContext; at: number } | null = null;
/** An open asked for longer ago than this did not lead to the overlay that is showing. */
const OPEN_INTENT_MS = 4000;

export function noteTitleOpen(titleId: string, context: TelemetryContext): void {
  pendingOpen = { titleId, context, at: Date.now() };
}

/** The context noted for `titleId` (and forget it), or null when nothing in the app opened it. */
export function takeTitleOpen(titleId: string): TelemetryContext | null {
  const pending = pendingOpen;
  pendingOpen = null;
  if (!pending || pending.titleId !== titleId || Date.now() - pending.at > OPEN_INTENT_MS) {
    return null;
  }
  return pending.context;
}

/**
 * Props for a card link that opens the title overlay and notes where it was opened from: the
 * overlay convention's link props, with the open's context noted on click.
 */
export function cardLinkProps(titleId: string, context: TelemetryContext) {
  const link = titleOverlayLinkProps(titleId);
  return {
    ...link,
    onClick: (event: { currentTarget: Element }) => {
      noteTitleOpen(titleId, context);
      link.onClick(event);
    },
  };
}

/** How far into a preview clip the member watched (all of it, once it ended), in seconds. */
export function watchedSeconds(handle: PreviewPlayerHandle | null): number {
  const media = handle?.media;
  const seconds = media ? media.currentTime || media.duration : 0;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 : 0;
}

/** Report an event (fire and forget; the telemetry module decides whether anything is sent). */
export { track };
