import { BROWSE_VIEWS, type PlaybackSession, type Row, type TitleCard } from "@webflix/contracts";
import type { Viewer } from "../env.ts";
import { check, equal, problem, rejects, succeeds } from "../expect.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, browseAll, CSRF, cardsOfRow, unique } from "./util.ts";

/** Watch `card` to `positionSec` (start, one heartbeat, stop): what a short viewing leaves behind. */
export async function watch(
  viewer: Viewer,
  card: TitleCard,
  position: (session: PlaybackSession) => number,
  options: { episodeId?: string; state?: "playing" | "ended" } = {},
): Promise<{ session: PlaybackSession; positionSec: number }> {
  const session = await succeeds(
    () =>
      viewer.agent.api.createPlaybackSession({
        body: { titleId: card.id, ...(options.episodeId ? { episodeId: options.episodeId } : {}) },
      }),
    `start playback of ${card.id}`,
  );
  const positionSec = position(session);
  await succeeds(
    () =>
      viewer.agent.api.sendHeartbeat({
        params: { id: session.id },
        body: { positionSec, durationSec: session.durationSec, state: options.state ?? "playing" },
      }),
    `heartbeat ${card.id} at ${positionSec}s`,
  );
  await succeeds(
    () => viewer.agent.api.endPlaybackSession({ params: { id: session.id } }),
    `stop ${card.id}`,
  );
  return { session, positionSec };
}

/** A movie long enough to be "in progress" (≥ 30 s watched, < 95 %) at a 2-minute mark. */
export async function longMovie(
  ctx: CheckContext,
  viewer: Viewer,
  skip: Set<string> = new Set(),
): Promise<{ card: TitleCard; durationSec: number }> {
  const { cards } = await ctx.env.catalog();
  for (const card of cards
    .filter((candidate) => candidate.type === "movie" && !skip.has(candidate.id))
    .slice(0, 12)) {
    const session = await viewer.agent.api
      .createPlaybackSession({ body: { titleId: card.id } })
      .catch(() => null);
    if (!session) continue;
    await viewer.agent.api.endPlaybackSession({ params: { id: session.id } });
    if (session.durationSec >= 200) return { card, durationSec: session.durationSec };
  }
  ctx.skip("no playable movie of at least 200 s to leave in progress");
}

/** The first series whose first season has two playable episodes (after `skip`). */
async function seriesWithTwoEpisodes(
  ctx: CheckContext,
  viewer: Viewer,
  skip: Set<string> = new Set(),
): Promise<{ card: TitleCard; first: string; second: string } | null> {
  const { cards } = await ctx.env.catalog();
  for (const card of cards
    .filter((candidate) => candidate.type === "series" && !skip.has(candidate.id))
    .slice(0, 10)) {
    const episodes = await succeeds(
      () => viewer.agent.api.listEpisodes({ params: { id: card.id, seasonNumber: 1 } }),
      `episodes of ${card.id}`,
    );
    const [first, second] = episodes.items;
    if (first?.isPlayable && second?.isPlayable)
      return { card, first: first.id, second: second.id };
  }
  return null;
}

export const libraryChecks: CheckDefinition[] = [
  {
    id: "library.my-list",
    area: "library",
    title: "My List add/remove round trip, newest first, reflected in viewer state",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("my-list");
      const { cards } = await ctx.env.catalog();
      const [first, second] = cards;
      check(first && second, "need two titles");
      const api = viewer.agent.api;
      await succeeds(
        () => api.addToMyList({ params: { titleId: first.id } }),
        "PUT /my-list (first)",
      );
      await succeeds(
        () => api.addToMyList({ params: { titleId: first.id } }),
        "PUT /my-list again (idempotent)",
      );
      await succeeds(
        () => api.addToMyList({ params: { titleId: second.id } }),
        "PUT /my-list (second)",
      );
      const list = await succeeds(() => api.getMyList(), "GET /my-list");
      equal(
        list.items.map((item) => item.id).join(","),
        `${second.id},${first.id}`,
        "My List order (most recent first)",
      );
      check(
        list.items.every((item) => item.viewer.inMyList),
        "cards in My List do not say inMyList",
      );
      equal(
        (await succeeds(() => api.getTitle({ params: { id: first.id } }), "detail")).viewer
          .inMyList,
        true,
        "detail inMyList after add",
      );
      const page = await succeeds(
        () => api.getMyList({ query: { limit: 1 } }),
        "GET /my-list?limit=1",
      );
      check(page.items.length === 1 && page.nextCursor, "My List does not paginate", {
        observed: JSON.stringify(page).slice(0, 200),
      });
      await succeeds(
        () => api.removeFromMyList({ params: { titleId: first.id } }),
        "DELETE /my-list",
      );
      await succeeds(
        () => api.removeFromMyList({ params: { titleId: first.id } }),
        "DELETE /my-list again (idempotent)",
      );
      const after = await succeeds(() => api.getMyList(), "GET /my-list after removal");
      equal(after.items.map((item) => item.id).join(","), second.id, "My List after removal");
      equal(
        (await succeeds(() => api.getTitle({ params: { id: first.id } }), "detail")).viewer
          .inMyList,
        false,
        "detail inMyList after removal",
      );
      await rejects(
        () => api.addToMyList({ params: { titleId: unique("t-smoke-none") } }),
        "not_found",
        "unknown title",
      );
    },
  },
  {
    id: "library.ratings",
    area: "library",
    title: "Ratings round trip (love, dislike, clear) reflected in viewer state",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("ratings");
      const api = viewer.agent.api;
      const home = await browseAll(viewer.agent, "home", 3);
      const target = home.rows.filter((row) => row.kind !== "top-10").flatMap(cardsOfRow)[0];
      check(target, "no title on the home rows to rate");
      await succeeds(
        () => api.rateTitle({ params: { titleId: target.id }, body: { value: "love" } }),
        "PUT /ratings love",
      );
      equal(
        (await succeeds(() => api.getTitle({ params: { id: target.id } }), "detail")).viewer.rating,
        "love",
        "rating after love",
      );
      await succeeds(
        () => api.rateTitle({ params: { titleId: target.id }, body: { value: "dislike" } }),
        "PUT /ratings dislike",
      );
      equal(
        (await succeeds(() => api.getTitle({ params: { id: target.id } }), "detail")).viewer.rating,
        "dislike",
        "rating after dislike",
      );
      await succeeds(() => api.clearRating({ params: { titleId: target.id } }), "DELETE /ratings");
      await succeeds(
        () => api.clearRating({ params: { titleId: target.id } }),
        "DELETE /ratings again (idempotent)",
      );
      equal(
        (await succeeds(() => api.getTitle({ params: { id: target.id } }), "detail")).viewer.rating,
        null,
        "rating after clearing",
      );
      problem(
        await viewer.agent.fetch(`${API}/ratings/${target.id}`, {
          method: "PUT",
          headers: CSRF,
          body: { value: "meh" },
        }),
        "validation_failed",
        "an unknown rating value",
      );
      await rejects(
        () =>
          api.rateTitle({ params: { titleId: unique("t-smoke-none") }, body: { value: "like" } }),
        "not_found",
        "rating an unknown title",
      );
    },
  },
  {
    id: "library.dislikes-leave-rows",
    area: "library",
    title: "Disliked titles disappear from every personalised row of every view",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("dislikes");
      const api = viewer.agent.api;
      // Top 10 is a popularity chart and My List the member's own picks: both keep disliked
      // titles, as documented (docs/RECOMMENDATIONS.md, "Dislikes").
      const personalised = (row: Row) => row.layout !== "ranked" && !row.id.endsWith(":my-list");
      const disliked = new Map<string, string>();
      for (const view of BROWSE_VIEWS) {
        const { rows } = await browseAll(viewer.agent, view, 4);
        for (const row of rows.filter(personalised)) {
          const card = cardsOfRow(row).find((candidate) => !disliked.has(candidate.id));
          if (card) disliked.set(card.id, row.id);
        }
      }
      check(disliked.size > 0, "no personalised row to take a title from");
      for (const titleId of disliked.keys()) {
        await succeeds(
          () => api.rateTitle({ params: { titleId }, body: { value: "dislike" } }),
          `dislike ${titleId}`,
        );
      }
      const offenders: string[] = [];
      for (const view of BROWSE_VIEWS) {
        const { rows } = await browseAll(viewer.agent, view, 4);
        for (const row of rows.filter(personalised)) {
          for (const card of cardsOfRow(row)) {
            if (disliked.has(card.id)) offenders.push(`${card.id} in ${row.id}`);
          }
        }
      }
      check(offenders.length === 0, "disliked titles still appear in rows", {
        expected: `none of ${disliked.size} disliked titles in any non-ranked row`,
        observed: offenders.join(", "),
      });
      ctx.note(
        `${disliked.size} titles disliked (one from each row), absent from all rows afterwards`,
      );
    },
  },
  {
    id: "library.continue-watching",
    area: "library",
    title: "Heartbeats drive Continue Watching, resume points and play targets; removal hides",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("continue");
      const api = viewer.agent.api;
      const { card } = await longMovie(ctx, viewer);
      const { positionSec } = await watch(viewer, card, () => 120);
      const list = await succeeds(() => api.getContinueWatching(), "GET /continue-watching");
      const item = list.items.find((entry) => entry.title.id === card.id);
      check(item, `${card.id} is not in Continue Watching after a heartbeat at ${positionSec}s`, {
        observed: list.items.map((entry) => entry.title.id).join(", ") || "(empty)",
      });
      equal(item.episode, null, "movie item episode");
      equal(Math.round(item.progress.positionSec), positionSec, "Continue Watching position");
      const detail = await succeeds(() => api.getTitle({ params: { id: card.id } }), "detail");
      equal(
        Math.round(detail.viewer.progress?.positionSec ?? -1),
        positionSec,
        "detail viewer.progress",
      );
      equal(detail.playTarget?.action, "resume", "play target action");
      equal(Math.round(detail.playTarget?.positionSec ?? -1), positionSec, "play target position");
      const resumed = await succeeds(
        () => api.createPlaybackSession({ body: { titleId: card.id } }),
        "resume playback",
      );
      equal(Math.round(resumed.resumePositionSec), positionSec, "resumePositionSec");
      await succeeds(() => api.endPlaybackSession({ params: { id: resumed.id } }), "stop");
      const fromStart = await succeeds(
        () => api.createPlaybackSession({ body: { titleId: card.id, startPositionSec: 0 } }),
        "play from the beginning",
      );
      equal(fromStart.resumePositionSec, 0, "startPositionSec 0 overrides the resume point");
      await succeeds(() => api.endPlaybackSession({ params: { id: fromStart.id } }), "stop");
      await succeeds(
        () => api.removeFromContinueWatching({ params: { titleId: card.id } }),
        "DELETE /continue-watching",
      );
      const hidden = await succeeds(
        () => api.getContinueWatching(),
        "GET /continue-watching after removal",
      );
      check(
        !hidden.items.some((entry) => entry.title.id === card.id),
        "removed title is still in Continue Watching",
      );
      await watch(viewer, card, () => 150);
      const back = await succeeds(
        () => api.getContinueWatching(),
        "GET /continue-watching after watching again",
      );
      check(
        back.items.some((entry) => entry.title.id === card.id),
        "watching again does not bring the title back",
      );
    },
  },
  {
    id: "library.continue-watching-series",
    area: "library",
    title:
      "A series stays in Continue Watching at the next episode when it was only just started; a sampled title stays out; row, detail and Play agree",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("continue-series");
      const api = viewer.agent.api;
      const series = await seriesWithTwoEpisodes(ctx, viewer);
      if (!series) ctx.skip("no series with two playable episodes in season 1");
      // Episode 1 to the end; autoplay starts episode 2 and the member leaves two seconds in.
      await watch(viewer, series.card, (session) => session.durationSec, {
        episodeId: series.first,
        state: "ended",
      });
      await watch(viewer, series.card, () => 2, { episodeId: series.second });
      const list = await succeeds(() => api.getContinueWatching(), "GET /continue-watching");
      const item = list.items.find((entry) => entry.title.id === series.card.id);
      check(item, `${series.card.id} left Continue Watching after episode 2 played for 2 s`, {
        expected: `${series.card.id} at episode ${series.second}`,
        observed: list.items.map((entry) => entry.title.id).join(", ") || "(empty)",
      });
      equal(item.episode?.id, series.second, "Continue Watching episode");
      equal(item.progress.positionSec, 0, "Continue Watching position (a 2 s sample starts over)");
      equal(list.items[0]?.title.id, series.card.id, "most recent first");
      // The home row, the detail's play target and Play itself say the same.
      const home = await browseAll(viewer.agent, "home", 1);
      const row = home.rows.find((candidate) => candidate.layout === "continue");
      const rowItem =
        row?.layout === "continue"
          ? row.items.find((entry) => entry.title.id === series.card.id)
          : undefined;
      check(rowItem, "the home continue row disagrees with GET /continue-watching", {
        observed: row ? row.id : "no continue row",
      });
      equal(rowItem.episode?.id, series.second, "home row episode");
      equal(rowItem.progress.positionSec, 0, "home row position");
      const detail = await succeeds(
        () => api.getTitle({ params: { id: series.card.id } }),
        "detail",
      );
      equal(detail.playTarget?.episode?.id, series.second, "play target episode");
      equal(detail.playTarget?.positionSec, 0, "play target position");
      equal(detail.playTarget?.action, "play", "play target action");
      const played = await succeeds(
        () => api.createPlaybackSession({ body: { titleId: series.card.id } }),
        "Play on the series",
      );
      equal(played.episodeId, series.second, "Play starts episode 2");
      equal(played.resumePositionSec, 0, "from the start");
      await succeeds(() => api.endPlaybackSession({ params: { id: played.id } }), "stop");

      // A different series sampled for a few seconds is not something the member is watching.
      const sampled = await seriesWithTwoEpisodes(ctx, viewer, new Set([series.card.id]));
      if (sampled) {
        await watch(viewer, sampled.card, () => 3, { episodeId: sampled.first });
        const after = await succeeds(() => api.getContinueWatching(), "GET /continue-watching");
        check(
          !after.items.some((entry) => entry.title.id === sampled.card.id),
          "a series sampled for 3 s entered Continue Watching",
          { observed: after.items.map((entry) => entry.title.id).join(", ") },
        );
        const sampledDetail = await succeeds(
          () => api.getTitle({ params: { id: sampled.card.id } }),
          "detail of the sampled series",
        );
        equal(sampledDetail.playTarget?.action, "play", "sampled series play target action");
        equal(sampledDetail.playTarget?.positionSec, 0, "sampled series play target position");
      } else {
        ctx.note("only one series with two playable episodes: the sampling case was not checked");
      }
    },
  },
  {
    id: "library.history",
    area: "library",
    title: "Viewing activity lists newest first, paginates, and removal also clears progress",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("history");
      const api = viewer.agent.api;
      const first = await longMovie(ctx, viewer);
      const second = await longMovie(ctx, viewer, new Set([first.card.id]));
      await watch(viewer, first.card, () => 90);
      await watch(viewer, second.card, () => 90);
      const history = await succeeds(() => api.getHistory(), "GET /history");
      equal(
        history.items
          .slice(0, 2)
          .map((entry) => entry.title.id)
          .join(","),
        `${second.card.id},${first.card.id}`,
        "history order (most recent first)",
      );
      const page1 = await succeeds(
        () => api.getHistory({ query: { limit: 1 } }),
        "GET /history?limit=1",
      );
      check(page1.nextCursor, "history does not paginate");
      const page2 = await succeeds(
        () => api.getHistory({ query: { limit: 1, cursor: page1.nextCursor ?? "" } }),
        "history page 2",
      );
      equal(page2.items[0]?.title.id, first.card.id, "history page 2");
      const entry = history.items[0];
      check(entry, "no history entry");
      await succeeds(
        () => api.removeHistoryEntry({ params: { id: entry.id } }),
        "DELETE /history/:id",
      );
      const after = await succeeds(() => api.getHistory(), "GET /history after removal");
      check(!after.items.some((item) => item.id === entry.id), "removed entry is still listed");
      const detail = await succeeds(
        () => api.getTitle({ params: { id: second.card.id } }),
        "detail after removal",
      );
      equal(detail.viewer.progress, null, "progress after removing the history entry");
      const list = await succeeds(
        () => api.getContinueWatching(),
        "Continue Watching after removal",
      );
      check(
        !list.items.some((item) => item.title.id === second.card.id),
        "removed history still drives Continue Watching",
      );
      await rejects(
        () => api.removeHistoryEntry({ params: { id: entry.id } }),
        "not_found",
        "removing it again",
      );
    },
  },
  {
    id: "library.notifications",
    area: "library",
    title: "Notifications list new arrivals with an unread count; marking read is per profile",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("notify");
      const api = viewer.agent.api;
      const list = await succeeds(() => api.listNotifications(), "GET /notifications");
      if (list.items.length === 0)
        ctx.skip("no notifications for a new profile (no arrivals in the last 30 days)");
      equal(
        list.unreadCount,
        list.items.filter((item) => item.readAt === null).length,
        "unreadCount",
      );
      const unread = list.items.find((item) => item.readAt === null);
      check(unread, "a new profile has no unread notification");
      await succeeds(
        () => api.markNotificationsRead({ body: { ids: [unread.id] } }),
        "POST /notifications/read {ids}",
      );
      const one = await succeeds(() => api.listNotifications(), "GET /notifications");
      equal(one.unreadCount, list.unreadCount - 1, "unreadCount after reading one");
      check(
        one.items.find((item) => item.id === unread.id)?.readAt,
        "the read notification has no readAt",
      );
      await succeeds(
        () => api.markNotificationsRead({ body: {} }),
        "POST /notifications/read (all)",
      );
      const all = await succeeds(() => api.listNotifications(), "GET /notifications");
      equal(all.unreadCount, 0, "unreadCount after reading all");
      problem(
        await viewer.agent.fetch(`${API}/notifications/read`, {
          method: "POST",
          headers: CSRF,
          body: { ids: [] },
        }),
        "validation_failed",
        "an empty ids list",
      );
      const other = await ctx.env.isolatedViewer("notify-other");
      const theirs = await succeeds(
        () => other.agent.api.listNotifications(),
        "another profile's notifications",
      );
      check(
        theirs.unreadCount > 0,
        "reading on one profile marked another profile's notifications read",
      );
    },
  },
];
