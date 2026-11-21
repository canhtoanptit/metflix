import { useQueryClient } from "@tanstack/react-query";
import type { CardViewerState, TitleCard } from "@webflix/contracts";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { findCachedCard } from "./cache.ts";

/**
 * The current viewer state (My List, rating) of a title whose card was captured earlier, e.g.
 * by a hover preview. Optimistic updates patch every cached copy of the card; this follows them
 * (and their rollbacks), so a preview's buttons always show the truth.
 */
export function useLiveViewer(card: TitleCard): CardViewerState {
  const queryClient = useQueryClient();
  const current = useRef<CardViewerState>(card.viewer);

  const subscribe = useCallback(
    (notify: () => void) => {
      let scheduled = false;
      const read = () => {
        scheduled = false;
        const next = findCachedCard(queryClient, card.id)?.viewer;
        if (!next) return;
        if (next.inMyList !== current.current.inMyList || next.rating !== current.current.rating) {
          current.current = { inMyList: next.inMyList, rating: next.rating };
          notify();
        }
      };
      return queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || scheduled) return;
        // One optimistic change patches many queries: read once per burst.
        scheduled = true;
        queueMicrotask(read);
      });
    },
    [queryClient, card.id],
  );

  return useSyncExternalStore(
    subscribe,
    () => current.current,
    () => current.current,
  );
}
