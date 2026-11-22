import type { AppContainer } from "../container.ts";
import { requireViewer } from "../session.ts";
import type { AppContext, AreaHandlers } from "./types.ts";

/**
 * Milestone 1's library, notifications and playback, which no milestone 2 area owns. Thin
 * mappings onto `services.library` and `services.playback`.
 */
export function createStreamingHandlers(container: AppContainer): AreaHandlers<"streaming"> {
  const { services } = container;
  const viewer = (c: AppContext) => requireViewer(container, c);

  return {
    // --- Library ------------------------------------------------------------------------------
    getMyList: async ({ query }, c) =>
      services.library.getMyList(await viewer(c), query.cursor, query.limit),

    addToMyList: async ({ params }, c) =>
      services.library.addToMyList(await viewer(c), params.titleId),

    removeFromMyList: async ({ params }, c) =>
      services.library.removeFromMyList(await viewer(c), params.titleId),

    rateTitle: async ({ params, body }, c) =>
      services.library.rate(await viewer(c), params.titleId, body.value),

    clearRating: async ({ params }, c) =>
      services.library.clearRating(await viewer(c), params.titleId),

    getContinueWatching: async (_request, c) => services.library.continueWatching(await viewer(c)),

    removeFromContinueWatching: async ({ params }, c) =>
      services.library.removeFromContinueWatching(await viewer(c), params.titleId),

    getHistory: async ({ query }, c) =>
      services.library.history(await viewer(c), query.cursor, query.limit),

    removeHistoryEntry: async ({ params }, c) =>
      services.library.removeHistoryEntry(await viewer(c), params.id),

    // --- Notifications ------------------------------------------------------------------------
    listNotifications: async (_request, c) => services.library.notifications(await viewer(c)),

    markNotificationsRead: async ({ body }, c) =>
      services.library.markNotificationsRead(await viewer(c), body.ids),

    // --- Playback -----------------------------------------------------------------------------
    createPlaybackSession: async ({ body }, c) => services.playback.start(await viewer(c), body),

    sendHeartbeat: async ({ params, body }, c) =>
      services.playback.heartbeat(await viewer(c), params.id, body),

    endPlaybackSession: async ({ params, body }, c) =>
      services.playback.end(await viewer(c), params.id, body),
  };
}
