/**
 * Playback activity showing up where the backend says it should (docs/RECOMMENDATIONS.md):
 * history, Continue Watching, the series play target, taste (match scores) and "Because You
 * Watched" rows. These are documented as read-after-write (personal signals are never cached),
 * so they are polled with a short timeout and the latency is reported.
 */
import { ApiError, OPENAPI_PATH, type TitlePopularityDay } from "@webflix/contracts";
import type { Viewer } from "../env.ts";
import { check, equal, fail, succeeds } from "../expect.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { watch } from "./library.ts";
import { API, browseAll, CSRF, cardsOfRow } from "./util.ts";

/**
 * Today's counters of a title from the popularity diagnostics (`GET /titles/:id/popularity`,
 * absent in production). Skips on a production target; fails when the route is missing.
 */
async function counters(
  ctx: CheckContext,
  viewer: Viewer,
  titleId: string,
  day?: string,
): Promise<TitlePopularityDay> {
  try {
    const popularity = await viewer.agent.api.getTitlePopularity({ params: { id: titleId } });
    const today = day ? popularity.days.find((entry) => entry.day === day) : popularity.days[0];
    check(today, `no counters for ${day ?? "today"}`, { observed: JSON.stringify(popularity) });
    return today;
  } catch (error) {
    if (!ApiError.is(error, "not_found")) throw error;
    const spec = await viewer.agent.fetch(OPENAPI_PATH);
    if (spec.status === 200 && spec.text().includes("/titles/{id}/popularity")) {
      ctx.skip("the popularity diagnostics are not served (WEBFLIX_ENV=production)");
    }
    fail("GET /titles/:id/popularity is missing", {
      expected: "the route of the contract (not_found only in production)",
      observed: `${error.status} ${error.code}`,
    });
  }
}

/**
 * Start measuring a movie no other check of this run takes, from the end of the catalogue
 * (read-only probes start at the other end), never the title the media checks keep playing in
 * the background, and long enough to play `minSec` of. Its counters are read before this
 * profile ever plays it; a title too short is released and the next one tried.
 */
async function measuredSession(ctx: CheckContext, viewer: Viewer, minSec: number) {
  const busy = (await ctx.env.media()).packaged?.card.id;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const card = await ctx.env.allocateTitle(
      (candidate) => candidate.type === "movie" && candidate.id !== busy,
      "a movie to count views of",
      { fromEnd: true },
    );
    const before = await counters(ctx, viewer, card.id);
    const session = await viewer.agent.api
      .createPlaybackSession({ body: { titleId: card.id } })
      .catch(() => null);
    if (!session) continue;
    if (session.durationSec >= minSec) return { card, session, before };
    await viewer.agent.api.endPlaybackSession({ params: { id: session.id } });
  }
  ctx.skip(`no playable movie of at least ${minSec} s among those tried`);
}

/** Poll the title's counters for `day` until `done` holds (the rollup runs after playback). */
function countersUntil(
  ctx: CheckContext,
  viewer: Viewer,
  titleId: string,
  day: string,
  what: string,
  done: (counts: TitlePopularityDay) => boolean,
) {
  return ctx.eventually(
    what,
    async () => {
      const counts = await counters(ctx, viewer, titleId, day);
      return done(counts)
        ? { done: true, value: counts }
        : { done: false, observed: JSON.stringify(counts) };
    },
    { timeoutMs: Math.max(ctx.options.eventualTimeoutMs, 60_000) },
  );
}

export const pipelineChecks: CheckDefinition[] = [
  {
    id: "pipeline.watch-signals",
    area: "pipeline",
    title: "Finishing a movie warms the profile: history, match scores, Because You Watched",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("signals");
      const api = viewer.agent.api;
      const before = await browseAll(viewer.agent, "home", 2);
      const scoredBefore = before.rows
        .flatMap(cardsOfRow)
        .filter((card) => card.matchScore !== null);
      equal(scoredBefore.length, 0, "match scores on a profile with no history (cold start: null)");
      const { cards } = await ctx.env.catalog();
      const movie = cards.find((card) => card.type === "movie" && card.genres.length > 0);
      check(movie, "need a movie with genres");
      await watch(viewer, movie, (session) => Math.max(1, session.durationSec * 0.5));
      await watch(viewer, movie, (session) => session.durationSec, { state: "ended" });
      const history = await ctx.eventually("the finished movie in viewing activity", async () => {
        const page = await succeeds(() => api.getHistory(), "GET /history");
        return page.items.some((entry) => entry.title.id === movie.id)
          ? { done: true, value: page }
          : {
              done: false,
              observed: `history: ${page.items.map((entry) => entry.title.id).join(", ") || "(empty)"}`,
            };
      });
      const rows = await ctx.eventually(
        `a "Because you watched ${movie.name}" row and match scores`,
        async () => {
          const home = await browseAll(viewer.agent, "home", 4);
          const because = home.rows.find(
            (row) => row.kind === "because-you-watched" && row.context.sourceTitle?.id === movie.id,
          );
          const scored = home.rows
            .flatMap(cardsOfRow)
            .filter((card) => card.matchScore !== null).length;
          return because && scored > 0
            ? { done: true, value: { because, scored } }
            : {
                done: false,
                observed: `rows: ${home.rows.map((row) => row.kind).join(", ")}; ${scored} scored cards`,
              };
        },
      );
      check(
        !cardsOfRow(rows.value.because).some((card) => card.id === movie.id),
        "Because You Watched lists its own source",
      );
      const detail = await succeeds(
        () => api.getTitle({ params: { id: movie.id } }),
        "detail of the finished movie",
      );
      equal(detail.viewer.progress?.completed, true, "progress.completed after state=ended");
      const continueWatching = await succeeds(
        () => api.getContinueWatching(),
        "GET /continue-watching",
      );
      check(
        !continueWatching.items.some((item) => item.title.id === movie.id),
        "a finished movie stays in Continue Watching",
      );
      ctx.note(
        `history after ${history.elapsedMs} ms; taste and Because You Watched after ${rows.elapsedMs} ms (${rows.attempts} polls)`,
      );
    },
  },
  {
    id: "pipeline.series-advance",
    area: "pipeline",
    title: "Finishing an episode moves the series on to the next episode at 0",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("series-advance");
      const api = viewer.agent.api;
      const { cards } = await ctx.env.catalog();
      let chosen: { id: string; name: string; first: string; second: string } | null = null;
      for (const card of cards.filter((candidate) => candidate.type === "series").slice(0, 10)) {
        const episodes = await succeeds(
          () => api.listEpisodes({ params: { id: card.id, seasonNumber: 1 } }),
          `episodes of ${card.id}`,
        );
        const [first, second] = episodes.items;
        if (first?.isPlayable && second?.isPlayable) {
          chosen = { id: card.id, name: card.name, first: first.id, second: second.id };
          break;
        }
      }
      if (!chosen) ctx.skip("no series with two playable episodes in season 1");
      const series = cards.find((card) => card.id === chosen.id);
      check(series, "series card");
      await watch(viewer, series, (session) => session.durationSec, {
        episodeId: chosen.first,
        state: "ended",
      });
      const item = await ctx.eventually(
        `${chosen.name} offering episode 2 in Continue Watching`,
        async () => {
          const list = await succeeds(() => api.getContinueWatching(), "GET /continue-watching");
          const entry = list.items.find((candidate) => candidate.title.id === chosen.id);
          return entry?.episode?.id === chosen.second
            ? { done: true, value: entry }
            : {
                done: false,
                observed: entry ? `episode ${entry.episode?.id ?? "none"}` : "series not listed",
              };
        },
      );
      equal(item.value.progress.positionSec, 0, "next episode starts at 0");
      const detail = await succeeds(
        () => api.getTitle({ params: { id: chosen.id } }),
        "series detail",
      );
      equal(detail.playTarget?.episode?.id, chosen.second, "play target episode");
      equal(detail.playTarget?.positionSec, 0, "play target position");
      const episodes = await succeeds(
        () => api.listEpisodes({ params: { id: chosen.id, seasonNumber: 1 } }),
        "episodes",
      );
      equal(episodes.items[0]?.progress?.completed, true, "episode 1 progress.completed");
      const next = await succeeds(
        () => api.createPlaybackSession({ body: { titleId: chosen.id } }),
        "Play on the series",
      );
      equal(next.episodeId, chosen.second, "Play starts the next episode");
      equal(next.resumePositionSec, 0, "from the start");
      await succeeds(() => api.endPlaybackSession({ params: { id: next.id } }), "stop");
      ctx.note(`Continue Watching advanced after ${item.elapsedMs} ms`);
    },
  },
  {
    id: "pipeline.credit-bounded",
    area: "pipeline",
    title:
      "Watch time cannot be inflated: a burst of heartbeats claiming a minute is credited the seconds that passed, and is no view",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("credit-bounded");
      const marker = await ctx.env.isolatedViewer("credit-marker");
      const { card, session, before } = await measuredSession(ctx, viewer, 70);
      const started = performance.now();
      // Thirteen reports, as fast as they go, claiming five more seconds each.
      for (let beat = 1; beat <= 13; beat += 1) {
        await succeeds(
          () =>
            viewer.agent.api.sendHeartbeat({
              params: { id: session.id },
              body: { positionSec: beat * 5, durationSec: session.durationSec, state: "playing" },
            }),
          `heartbeat ${beat}`,
        );
      }
      await succeeds(
        () =>
          viewer.agent.api.endPlaybackSession({
            params: { id: session.id },
            body: { positionSec: 66, durationSec: session.durationSec, state: "paused" },
          }),
        "release with the final position",
      );
      const elapsedSec = (performance.now() - started) / 1000;
      // Another profile plays the title only now: once the counters include it, they include
      // the measured session's final state too (the rollup recomputes the whole day).
      const probe = await succeeds(
        () => marker.agent.api.createPlaybackSession({ body: { titleId: card.id } }),
        "the marker profile starts the title",
      );
      await succeeds(
        () => marker.agent.api.endPlaybackSession({ params: { id: probe.id } }),
        "the marker profile stops",
      );
      const after = await countersUntil(
        ctx,
        viewer,
        card.id,
        before.day,
        `the counters of ${card.id} including a rollup after the release`,
        (counts) => counts.playbackProfiles >= before.playbackProfiles + 2,
      );
      const credited = after.value.playbackWatchSec - before.playbackWatchSec;
      check(credited <= elapsedSec + 1, "watch time was credited beyond the time that passed", {
        expected: `≤ ${elapsedSec.toFixed(1)} s (+1 s for clock skew): the session existed that long`,
        observed: `${credited.toFixed(1)} s credited for 66 s claimed`,
      });
      equal(
        after.value.playbackViews,
        before.playbackViews,
        "views (a view needs 60 s of watching)",
      );
      ctx.note(
        `66 s claimed in ${elapsedSec.toFixed(1)} s, ${credited.toFixed(1)} s credited; rolled up after ${after.elapsedMs} ms`,
      );
    },
  },
  {
    id: "pipeline.popularity-view",
    area: "pipeline",
    title:
      "A minute of real watching adds exactly one view to the title's daily counters (what Top 10 and Trending rank)",
    tags: ["slow"],
    timeoutMs: 240_000,
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("popularity-view");
      const { card, session, before } = await measuredSession(ctx, viewer, 80);
      const durationSec = session.durationSec;
      // Play like a player does: the position follows the clock, a report every few seconds.
      const started = performance.now();
      const position = () => Math.min((performance.now() - started) / 1000, durationSec - 1);
      while (position() < 66) {
        await ctx.sleep(5_000);
        await succeeds(
          () =>
            viewer.agent.api.sendHeartbeat({
              params: { id: session.id },
              body: { positionSec: position(), durationSec, state: "playing" },
            }),
          "heartbeat",
        );
      }
      const stoppedAt = position();
      await succeeds(
        () =>
          viewer.agent.api.endPlaybackSession({
            params: { id: session.id },
            body: { positionSec: stoppedAt, durationSec, state: "paused" },
          }),
        "release with the final position",
      );
      const elapsedSec = (performance.now() - started) / 1000;
      const after = await countersUntil(
        ctx,
        viewer,
        card.id,
        before.day,
        `a view of ${card.id} counted`,
        (counts) => counts.playbackViews > before.playbackViews,
      );
      equal(
        after.value.playbackViews,
        before.playbackViews + 1,
        `views of ${card.id} on ${before.day} (one profile, one minute)`,
      );
      const credited = after.value.playbackWatchSec - before.playbackWatchSec;
      check(credited >= 60 && credited <= elapsedSec + 1, "credited watch time", {
        expected: `60..${(elapsedSec + 1).toFixed(1)} s`,
        observed: `${credited.toFixed(1)} s`,
      });
      // The release ended the session: nothing more can be reported on it.
      const late = await viewer.agent.fetch(`${API}/playback/sessions/${session.id}/heartbeat`, {
        method: "POST",
        headers: CSRF,
        body: { positionSec: stoppedAt + 5, durationSec, state: "playing" },
      });
      equal(late.status, 410, "a heartbeat after the release", late.exchange);
      ctx.note(
        `${card.id}: ${before.playbackViews} → ${after.value.playbackViews} views, ${credited.toFixed(1)} s credited for ${elapsedSec.toFixed(1)} s; rolled up after ${after.elapsedMs} ms`,
      );
    },
  },
];
