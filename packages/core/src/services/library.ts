import type {
  ContinueWatchingList,
  HistoryPage,
  MyListPage,
  NotificationList,
  RatingValue,
} from "@webflix/contracts";
import * as z from "zod";
import { encodeCursor } from "../domain/cursor.ts";
import { maturityRank } from "../domain/maturity.ts";
import { AppError } from "../errors.ts";
import { toIsoString } from "../ports/clock.ts";
import type { Personalization } from "../recommendations/engine.ts";
import { DAY_MS } from "../recommendations/hash.ts";
import type { ServiceDependencies, ServiceState, Viewer } from "./context.ts";
import { decodeOrFail, pageOf } from "./pagination.ts";
import {
  presentCards,
  presentContinueItem,
  presentEpisodeRef,
  presentNotification,
} from "./presenters.ts";

const HistoryCursor = z.object({ w: z.number().int(), i: z.string().min(1).max(64) });

/** Notifications older than this are not shown. */
const NOTIFICATION_WINDOW_MS = 60 * DAY_MS;
/** How far back, before a profile was created, its highlights may reach. */
const NOTIFICATION_BACKFILL_MS = 30 * DAY_MS;
/**
 * A new profile opens with no backlog: only what arrives after it was created is unread. It
 * still sees the latest few arrivals from before, already read, so the list is not empty.
 */
const NOTIFICATION_HIGHLIGHTS = 3;
const NOTIFICATION_LIMIT = 30;

export function createLibraryService(
  deps: ServiceDependencies,
  state: ServiceState,
  personalize: (viewer: Viewer) => Promise<Personalization>,
) {
  const { repos, clock } = deps;

  /** Writes about a title require it to exist and be visible to the profile. */
  async function requireVisible(viewer: Viewer, titleId: string): Promise<void> {
    const snapshot = await state.catalog.get();
    const title = snapshot.title(titleId);
    if (!title) throw new AppError("not_found", { detail: "No such title" });
    if (snapshot.maturityRankOf(titleId) > maturityRank(viewer.profile.maturityCeiling)) {
      throw new AppError("maturity_restricted", {
        maturity: title.maturity,
        profileMaturityCeiling: viewer.profile.maturityCeiling,
      });
    }
  }

  function notificationQuery(viewer: Viewer) {
    const now = clock.now();
    return {
      profileId: viewer.profile.id,
      maxMaturityRank: maturityRank(viewer.profile.maturityCeiling),
      since: Math.max(
        now - NOTIFICATION_WINDOW_MS,
        viewer.profile.createdAt - NOTIFICATION_BACKFILL_MS,
      ),
    };
  }

  return {
    async getMyList(
      viewer: Viewer,
      cursor: string | undefined,
      limit: number | undefined,
    ): Promise<MyListPage> {
      const personalization = await personalize(viewer);
      const ids = personalization.myListIds(null, Number.MAX_SAFE_INTEGER);
      const page = pageOf(ids, cursor, limit);
      return {
        items: presentCards(
          personalization,
          page.items,
          personalization.cardSurface(ids, "home", "list"),
        ),
        nextCursor: page.nextCursor,
      };
    },

    async addToMyList(viewer: Viewer, titleId: string): Promise<void> {
      await requireVisible(viewer, titleId);
      await repos.library.addToMyList(viewer.profile.id, titleId, clock.now());
    },

    async removeFromMyList(viewer: Viewer, titleId: string): Promise<void> {
      await repos.library.removeFromMyList(viewer.profile.id, titleId);
    },

    async rate(viewer: Viewer, titleId: string, value: RatingValue): Promise<void> {
      await requireVisible(viewer, titleId);
      await repos.library.setRating(viewer.profile.id, titleId, value, clock.now());
    },

    async clearRating(viewer: Viewer, titleId: string): Promise<void> {
      await repos.library.clearRating(viewer.profile.id, titleId);
    },

    async continueWatching(viewer: Viewer): Promise<ContinueWatchingList> {
      const personalization = await personalize(viewer);
      const items = personalization.continueWatching();
      const surface = personalization.cardSurface(
        items.map((item) => item.titleId),
        "home",
        "progress",
      );
      return {
        items: items.flatMap((item) => presentContinueItem(personalization, item, surface) ?? []),
      };
    },

    async removeFromContinueWatching(viewer: Viewer, titleId: string): Promise<void> {
      await repos.library.hideFromContinueWatching(viewer.profile.id, titleId);
    },

    async history(viewer: Viewer, cursor: string | undefined, limit = 20): Promise<HistoryPage> {
      const before = decodeOrFail(cursor, HistoryCursor);
      const [snapshot, entries] = await Promise.all([
        state.catalog.get(),
        repos.library.listHistory(viewer.profile.id, {
          before: before ? { watchedAt: before.w, id: before.i } : undefined,
          limit,
        }),
      ]);
      const ceiling = maturityRank(viewer.profile.maturityCeiling);
      const last = entries[entries.length - 1];
      return {
        items: entries.flatMap((entry) => {
          const title = snapshot.title(entry.titleId);
          if (!title || snapshot.maturityRankOf(title.id) > ceiling) return [];
          const episode = entry.episodeId ? snapshot.episode(entry.episodeId) : undefined;
          return [
            {
              id: entry.id,
              watchedAt: toIsoString(entry.watchedAt),
              title: { id: title.id, name: title.name, type: title.type },
              episode: episode ? presentEpisodeRef(episode) : null,
            },
          ];
        }),
        nextCursor:
          entries.length === limit && last ? encodeCursor({ w: last.watchedAt, i: last.id }) : null,
      };
    },

    async removeHistoryEntry(viewer: Viewer, entryId: string): Promise<void> {
      const removed = await repos.library.deleteHistoryEntry(viewer.profile.id, entryId);
      if (!removed) throw new AppError("not_found", { detail: "No such entry" });
    },

    async notifications(viewer: Viewer): Promise<NotificationList> {
      const [snapshot, notifications] = await Promise.all([
        state.catalog.get(),
        repos.notifications.listForProfile({
          ...notificationQuery(viewer),
          limit: NOTIFICATION_LIMIT,
        }),
      ]);
      const createdAt = viewer.profile.createdAt;
      const since = notifications.filter((notification) => notification.createdAt >= createdAt);
      const highlights = notifications
        .filter((notification) => notification.createdAt < createdAt)
        .slice(0, NOTIFICATION_HIGHLIGHTS)
        .map((notification) => ({ ...notification, readAt: notification.readAt ?? createdAt }));
      const shown = [...since, ...highlights];
      return {
        items: shown.map((notification) => presentNotification(snapshot, notification)),
        unreadCount: shown.filter((notification) => notification.readAt === null).length,
      };
    },

    async markNotificationsRead(viewer: Viewer, ids: readonly string[] | undefined): Promise<void> {
      await repos.notifications.markRead(notificationQuery(viewer), ids ?? "all", clock.now());
    },
  };
}

export type LibraryService = ReturnType<typeof createLibraryService>;
