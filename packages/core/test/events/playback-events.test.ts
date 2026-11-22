/**
 * Playback's server events (start, progress, complete, abandon), emitted by the milestone 1
 * playback service through the seam, and proof that adding them changed neither what the routes
 * return nor what they cost.
 */
import type { LakeEvent } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import {
  heartbeatCredit,
  playbackEventId,
  quartersCrossed,
} from "../../src/areas/events/playback-events.ts";
import type { Viewer } from "../../src/index.ts";
import { createMemoryRepositories } from "../../src/memory/index.ts";
import { createMember, eventServices, lakeEvents, settle } from "./helpers.ts";

type Payload = { positionSec: number; durationSec: number; watchedSec: number; reason?: string };
const payloadOf = (event: LakeEvent | undefined) => event?.payload as Payload | undefined;

async function adultViewer(t: Awaited<ReturnType<typeof eventServices>>): Promise<Viewer> {
  const member = await createMember(t);
  return { session: member.as("adult").session, profile: member.profiles.adult };
}

describe("playback server events", () => {
  it("emits start, a progress event per quarter crossed by credited watching, and complete", async () => {
    const t = await eventServices({}, {});
    const viewer = await adultViewer(t);
    const session = await t.services.playback.start(viewer, { titleId: "t-lanterns" });
    const duration = session.durationSec;
    expect(duration).toBeGreaterThan(0);
    // Watch in 30 s steps (the heartbeat interval), credited as played.
    let position = 0;
    while (position < duration) {
      t.clock.advance(30_000);
      position = Math.min(duration, position + 30);
      await t.services.playback.heartbeat(viewer, session.id, {
        positionSec: position,
        durationSec: duration,
        state: position >= duration ? "ended" : "playing",
      });
    }
    await t.services.playback.end(viewer, session.id);
    await settle(t);
    const events = lakeEvents(t.sink).filter((event) => event.type.startsWith("playback."));
    expect(events.map((event) => event.type)).toEqual([
      "playback.start",
      "playback.progress",
      "playback.progress",
      "playback.progress",
      "playback.complete",
    ]);
    const progress = events.filter((event) => event.type === "playback.progress");
    progress.forEach((event, index) => {
      expect(payloadOf(event)?.watchedSec).toBeGreaterThanOrEqual((duration * (index + 1)) / 4);
    });
    // Complete at the completion ratio (95%), not only at the very end.
    expect(payloadOf(events.at(-1))?.positionSec).toBeGreaterThanOrEqual(duration * 0.95);
    for (const event of events) {
      expect(event.context.surface).toBe("player");
      expect(event.source).toBe("server");
      expect((event.payload as { playbackSessionId: string }).playbackSessionId).toBe(session.id);
    }
    // No abandon after a completion.
    expect(events.some((event) => event.type === "playback.abandon")).toBe(false);
  });

  it("emits abandon (closed) when the member leaves before the end, with the final report", async () => {
    const t = await eventServices({}, {});
    const viewer = await adultViewer(t);
    const session = await t.services.playback.start(viewer, { titleId: "t-lanterns" });
    t.clock.advance(30_000);
    await t.services.playback.end(viewer, session.id, {
      positionSec: 30,
      durationSec: session.durationSec,
      state: "paused",
    });
    await settle(t);
    const abandon = lakeEvents(t.sink).find((event) => event.type === "playback.abandon");
    expect(payloadOf(abandon)).toMatchObject({ reason: "closed", positionSec: 30, watchedSec: 30 });
  });

  it("emits abandon (replaced) for the session another start on the same device replaced", async () => {
    const t = await eventServices({}, {});
    const viewer = await adultViewer(t);
    const first = await t.services.playback.start(viewer, { titleId: "t-lanterns" });
    t.clock.advance(5_000);
    await t.services.playback.start(viewer, { titleId: "t-thaw" });
    await settle(t);
    const abandon = lakeEvents(t.sink).find((event) => event.type === "playback.abandon");
    expect(abandon?.payload).toMatchObject({ playbackSessionId: first.id, reason: "replaced" });
  });

  it("emits abandon (stalled) when a heartbeat finds the stream slot gone", async () => {
    const t = await eventServices({}, {});
    const viewer = await adultViewer(t);
    const session = await t.services.playback.start(viewer, { titleId: "t-lanterns" });
    await t.gate.releaseAll(viewer.session.accountId);
    await expect(
      t.services.playback.heartbeat(viewer, session.id, {
        positionSec: 10,
        durationSec: session.durationSec,
        state: "playing",
      }),
    ).rejects.toMatchObject({ code: "playback_session_ended" });
    await settle(t);
    const abandon = lakeEvents(t.sink).find((event) => event.type === "playback.abandon");
    expect(abandon?.payload).toMatchObject({ reason: "stalled" });
  });

  it("gives a milestone of a session the same event id every time (deduplicated downstream)", async () => {
    const a = await playbackEventId("ps-1", Date.UTC(2026, 10, 22, 10), "progress:2");
    const b = await playbackEventId("ps-1", Date.UTC(2026, 10, 22, 10), "progress:2");
    const c = await playbackEventId("ps-1", Date.UTC(2026, 10, 22, 10), "progress:3");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // The time field is the session's start (UUIDv7 order).
    expect(Number.parseInt(a.replace("-", "").slice(0, 12), 16)).toBe(Date.UTC(2026, 10, 22, 10));
  });

  it("returns the same playback responses and costs the same round trips as without events", async () => {
    const run = async (withEvents: boolean) => {
      const repos = createMemoryRepositories();
      const t = await eventServices({}, { repos });
      if (!withEvents) {
        // Milestone 1's writes: the same calls without the outbox rows.
        const playback = repos.playback;
        repos.playback = {
          ...playback,
          create: (session) => playback.create(session),
          recordHeartbeat: ({ outbox: _outbox, ...write }) => playback.recordHeartbeat(write),
          end: (id, now) => playback.end(id, now),
        };
      }
      const viewer = await adultViewer(t);
      const before = repos.store.queries;
      const session = await t.services.playback.start(viewer, { titleId: "t-lanterns" });
      const afterStart = repos.store.queries;
      t.clock.advance(30_000);
      const ack = await t.services.playback.heartbeat(viewer, session.id, {
        positionSec: 30,
        durationSec: session.durationSec,
        state: "playing",
      });
      const afterBeat = repos.store.queries;
      await t.services.playback.end(viewer, session.id);
      const afterEnd = repos.store.queries;
      return {
        session: {
          ...session,
          id: "x",
          manifestUrl: "x",
          expiresAt: "x",
          textTracks: [],
          trickPlay: null,
        },
        ack,
        costs: [afterStart - before, afterBeat - afterStart, afterEnd - afterBeat],
        outbox: repos.store.eventOutbox.length,
        queued: t.queue.size,
      };
    };
    const without = await run(false);
    const withEvents = await run(true);
    expect(withEvents.session).toEqual(without.session);
    expect(withEvents.ack).toEqual(without.ack);
    expect(withEvents.costs).toEqual(without.costs);
    // The events were recorded in those same calls (start and abandon), and nothing was queued
    // beyond what milestone 1 queues (its stats rollup).
    expect(without.outbox).toBe(0);
    expect(withEvents.outbox).toBe(2);
    expect(withEvents.queued).toBe(without.queued);
  });

  it("writes nothing to the outbox for a kids profile", async () => {
    const repos = createMemoryRepositories();
    const t = await eventServices({}, { repos });
    const member = await createMember(t);
    const kids = { session: member.as("kids").session, profile: member.profiles.kids };
    const session = await t.services.playback.start(kids, { titleId: "t-lanterns" });
    t.clock.advance(30_000);
    await t.services.playback.end(kids, session.id, {
      positionSec: session.durationSec,
      durationSec: session.durationSec,
      state: "ended",
    });
    expect(repos.store.eventOutbox).toEqual([]);
  });
});

describe("the credit mirror", () => {
  it("computes what recordHeartbeat credits, for every previous state", async () => {
    const repos = createMemoryRepositories();
    const t = await eventServices({}, { repos });
    const viewer = await adultViewer(t);
    const session = await t.services.playback.start(viewer, { titleId: "t-lanterns" });
    const reports = [
      { advanceMs: 30_000, positionSec: 28, state: "playing" as const },
      { advanceMs: 10_000, positionSec: 60, state: "paused" as const }, // more than the clock
      { advanceMs: 30_000, positionSec: 90, state: "playing" as const }, // paused before: nothing
      { advanceMs: 70_000, positionSec: 400, state: "buffering" as const }, // bounded by the clock
      { advanceMs: 30_000, positionSec: 380, state: "playing" as const }, // seek back: nothing
    ];
    for (const report of reports) {
      t.clock.advance(report.advanceMs);
      const before = await repos.playback.get(session.id);
      if (!before) throw new Error("session vanished");
      const expected =
        before.watchedSec + heartbeatCredit(before, report.positionSec, t.clock.now(), 90);
      await t.services.playback.heartbeat(viewer, session.id, {
        positionSec: report.positionSec,
        durationSec: session.durationSec,
        state: report.state,
      });
      expect((await repos.playback.get(session.id))?.watchedSec).toBeCloseTo(expected, 6);
    }
  });

  it("finds the quarters crossed", () => {
    expect(quartersCrossed(0, 100, 400)).toEqual([1]);
    expect(quartersCrossed(99, 301, 400)).toEqual([1, 2, 3]);
    expect(quartersCrossed(100, 100, 400)).toEqual([]);
    expect(quartersCrossed(0, 400, 0)).toEqual([]);
  });
});
