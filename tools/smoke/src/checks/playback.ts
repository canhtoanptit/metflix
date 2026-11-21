/**
 * Ending playback the way a closing page does: one `DELETE /playback/sessions/:id` that
 * carries the final position (docs/BACKEND.md §3), so the position cannot be lost to a final
 * heartbeat that arrives after the release.
 */
import { check, equal, problem, succeeds } from "../expect.ts";
import type { Agent, HttpResult } from "../http.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { longMovie } from "./library.ts";
import { API, CSRF } from "./util.ts";

function release(agent: Agent, id: string, body?: object): Promise<HttpResult> {
  return agent.fetch(`${API}/playback/sessions/${id}`, {
    method: "DELETE",
    headers: CSRF,
    ...(body === undefined ? {} : { body }),
  });
}

export const playbackChecks: CheckDefinition[] = [
  {
    id: "playback.release-final-position",
    area: "playback",
    title:
      "A release carrying the final position records it and frees the slot in one request; only the session's own profile may report",
    async run(ctx: CheckContext) {
      // A one-screen plan, so "the slot is free" is observable from a second device.
      const viewer = await ctx.env.viewer("release-final", { plan: "basic" });
      const api = viewer.agent.api;
      const { card } = await longMovie(ctx, viewer);
      const other = await ctx.env.createProfile(viewer.agent, { name: "Other" });
      const second = await ctx.env.login(viewer.account, "release-final-2");
      await ctx.env.selectProfile(second, other.id);

      const session = await succeeds(
        () => api.createPlaybackSession({ body: { titleId: card.id } }),
        `start ${card.id}`,
      );
      const final = { positionSec: 75, durationSec: session.durationSec, state: "paused" };

      // Another profile cannot record a position on it (nor free its slot that way).
      problem(
        await release(second, session.id, final),
        "not_found",
        "a final position from another profile",
      );
      problem(
        await second.fetch(`${API}/playback/sessions`, {
          method: "POST",
          headers: CSRF,
          body: { titleId: card.id },
        }),
        "stream_limit_reached",
        "the slot is still held after the refused report",
      );

      // The page closes: no heartbeat at all, only the release with the position.
      const released = await release(viewer.agent, session.id, final);
      equal(released.status, 204, "release with the final position", released.exchange);

      // The slot is free at once and the session is over.
      const next = await succeeds(
        () => second.api.createPlaybackSession({ body: { titleId: card.id } }),
        "another device takes the only screen",
      );
      await succeeds(() => second.api.endPlaybackSession({ params: { id: next.id } }), "stop");
      problem(
        await viewer.agent.fetch(`${API}/playback/sessions/${session.id}/heartbeat`, {
          method: "POST",
          headers: CSRF,
          body: final,
        }),
        "playback_session_ended",
        "a heartbeat after the release",
      );

      // The position was recorded: Continue Watching, the play target and Play agree on it.
      const list = await succeeds(() => api.getContinueWatching(), "GET /continue-watching");
      const item = list.items.find((entry) => entry.title.id === card.id);
      check(item, "the position carried by the release was not recorded", {
        expected: `${card.id} in Continue Watching at 75 s`,
        observed: list.items.map((entry) => entry.title.id).join(", ") || "(empty)",
      });
      equal(Math.round(item.progress.positionSec), 75, "Continue Watching position");
      const detail = await succeeds(() => api.getTitle({ params: { id: card.id } }), "detail");
      equal(Math.round(detail.playTarget?.positionSec ?? -1), 75, "play target position");
      const resumed = await succeeds(
        () => api.createPlaybackSession({ body: { titleId: card.id } }),
        "resume",
      );
      equal(Math.round(resumed.resumePositionSec), 75, "Play resumes there");

      // Without a body the release keeps its old meaning: idempotent, nothing recorded.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const plain = await release(viewer.agent, resumed.id);
        equal(plain.status, 204, `release without a body (${attempt})`, plain.exchange);
      }
      problem(
        await release(viewer.agent, resumed.id, final),
        "playback_session_ended",
        "a final position for a session already released",
      );
    },
  },
];
