import { ApiError, createProblem, type PlaybackSession } from "@webflix/contracts";
import { makePlaybackSession, resetFixtures } from "@webflix/contracts/fixtures";
import type { PlayerError, ProgressReport } from "@webflix/player";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  blockFromStartError,
  MAX_RECOVERIES,
  WatchLifecycle,
} from "../src/features/watch/lifecycle.ts";

/**
 * The watch page's session/heartbeat state machine, driven through a fake playback API: every
 * call is recorded in order, and each `createPlaybackSession` waits for the test to settle it,
 * so races (superseded requests, leaving mid-request) are exercised deterministically.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function problem<C extends Parameters<typeof createProblem>[0]>(
  ...args: Parameters<typeof createProblem<C>>
): ApiError {
  // `Problem<C>` for a generic C does not resolve to the union ApiError accepts.
  return new ApiError(createProblem(...args) as ConstructorParameters<typeof ApiError>[0]);
}

const networkError = () =>
  new ApiError({
    type: "urn:webflix:problem:network_error",
    title: "Network error",
    status: 0,
    code: "network_error",
  });

function session(overrides: Partial<PlaybackSession> = {}): PlaybackSession {
  return { ...makePlaybackSession(), ...overrides };
}

function harness(options: { snapshot?: (reason: string) => ProgressReport | null } = {}) {
  const calls: string[] = [];
  const creates: Array<{ body: unknown; result: Deferred<PlaybackSession>; signal?: AbortSignal }> =
    [];
  let heartbeat: (id: string, body: unknown) => Promise<{ heartbeatIntervalSec: number }> =
    async () => ({ heartbeatIntervalSec: 30 });
  const api = {
    createPlaybackSession: vi.fn((input: { body: unknown }, request?: { signal?: AbortSignal }) => {
      calls.push(`create ${JSON.stringify(input.body)}`);
      const result = deferred<PlaybackSession>();
      creates.push({ body: input.body, result, signal: request?.signal });
      return result.promise;
    }),
    sendHeartbeat: vi.fn(
      (input: { params: { id: string }; body: unknown }, request?: { keepalive?: boolean }) => {
        calls.push(
          `heartbeat ${input.params.id} ${JSON.stringify(input.body)}${request?.keepalive ? " keepalive" : ""}`,
        );
        return heartbeat(input.params.id, input.body);
      },
    ),
    endPlaybackSession: vi.fn(
      async (
        input: { params: { id: string }; body?: unknown },
        request?: { keepalive?: boolean },
      ) => {
        calls.push(
          `end ${input.params.id}${input.body ? ` ${JSON.stringify(input.body)}` : ""}${request?.keepalive ? " keepalive" : ""}`,
        );
      },
    ),
  };
  const changes: PlaybackSession[] = [];
  const lifecycle = new WatchLifecycle({
    // The fake implements exactly the three routes the lifecycle uses.
    api: api as unknown as ConstructorParameters<typeof WatchLifecycle>[0]["api"],
    snapshot: options.snapshot as ConstructorParameters<typeof WatchLifecycle>[0]["snapshot"],
    onSessionChange: (next) => changes.push(next),
  });
  return {
    lifecycle,
    api,
    calls,
    creates,
    changes,
    setHeartbeat(fn: typeof heartbeat) {
      heartbeat = fn;
    },
    /** Settle the newest pending create. */
    async resolveCreate(value: PlaybackSession, index = creates.length - 1) {
      creates[index]?.result.resolve(value);
      await flush();
    },
    async rejectCreate(error: unknown, index = creates.length - 1) {
      creates[index]?.result.reject(error);
      await flush();
    },
  };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function report(sessionId: string, overrides: Partial<ProgressReport> = {}): ProgressReport {
  return {
    sessionId,
    positionSec: 120,
    durationSec: 1800,
    state: "playing",
    reason: "interval",
    ...overrides,
  };
}

beforeEach(() => resetFixtures());

describe("starting playback", () => {
  it("creates a session for the target and becomes ready", async () => {
    const h = harness();
    const opened = h.lifecycle.open({ titleId: "t-1", episodeId: "e-2", startPositionSec: 0 });
    expect(h.lifecycle.getState()).toMatchObject({ status: "starting", switching: true });
    expect(h.calls).toEqual(['create {"titleId":"t-1","episodeId":"e-2","startPositionSec":0}']);
    const created = session({ id: "ps-1", heartbeatIntervalSec: 20, resumePositionSec: 0 });
    await h.resolveCreate(created);
    await opened;
    expect(h.lifecycle.getState()).toMatchObject({
      status: "ready",
      session: created,
      switching: false,
      heartbeatIntervalSec: 20,
    });
    expect(h.changes).toEqual([created]);
  });

  it.each([
    [
      problem("stream_limit_reached", { limit: 1, activeStreams: [] }),
      { kind: "stream-limit", limit: 1, activeStreams: [] },
    ],
    [
      problem("subscription_required", { subscriptionStatus: "ended" }),
      { kind: "membership", subscriptionStatus: "ended" },
    ],
    [
      problem("maturity_restricted", { maturity: "16+", profileMaturityCeiling: "7+" }),
      { kind: "maturity", maturity: "16+", ceiling: "7+" },
    ],
    [problem("not_found"), { kind: "not-found" }],
    [problem("media_unavailable"), { kind: "unavailable" }],
    [problem("unauthenticated"), { kind: "signed-out" }],
    [problem("profile_required"), { kind: "profile-required" }],
    [networkError(), { kind: "offline" }],
  ])("maps a refused start onto a designed screen (%#)", async (error, block) => {
    const h = harness();
    void h.lifecycle.open({ titleId: "t-1" });
    await h.rejectCreate(error);
    expect(h.lifecycle.getState()).toMatchObject({ status: "blocked", block });
    expect(blockFromStartError(error)).toEqual(block);
  });

  it("only the newest request wins; a superseded session is released at once", async () => {
    const h = harness();
    void h.lifecycle.open({ titleId: "t-1" });
    void h.lifecycle.open({ titleId: "t-2" });
    expect(h.creates[0]?.signal?.aborted).toBe(true);
    await h.resolveCreate(session({ id: "ps-new", titleId: "t-2" }), 1);
    // The first request's answer arrives late anyway (the abort raced the response).
    await h.resolveCreate(session({ id: "ps-old", titleId: "t-1" }), 0);
    expect(h.lifecycle.getState().session?.id).toBe("ps-new");
    expect(h.calls).toContain("end ps-old keepalive");
    expect(h.changes.map((item) => item.id)).toEqual(["ps-new"]);
  });

  it("leaving while the session is being created releases it when it arrives", async () => {
    const h = harness();
    void h.lifecycle.open({ titleId: "t-1" });
    await h.lifecycle.finish();
    await h.resolveCreate(session({ id: "ps-late" }));
    expect(h.calls.at(-1)).toBe("end ps-late keepalive");
    expect(h.lifecycle.getState().session).toBeNull();
  });

  it("retries the last target after a stream-limit refusal", async () => {
    const h = harness();
    void h.lifecycle.open({ titleId: "t-1", episodeId: "e-1" });
    await h.rejectCreate(problem("stream_limit_reached", { limit: 1, activeStreams: [] }));
    void h.lifecycle.retry();
    expect(h.lifecycle.getState().status).toBe("starting");
    expect(h.calls.at(-1)).toBe('create {"titleId":"t-1","episodeId":"e-1"}');
    await h.resolveCreate(session({ id: "ps-1", titleId: "t-1", episodeId: "e-1" }));
    expect(h.lifecycle.getState().status).toBe("ready");
  });
});

describe("heartbeats", () => {
  async function ready(h: ReturnType<typeof harness>, value = session({ id: "ps-1" })) {
    void h.lifecycle.open({ titleId: value.titleId, episodeId: value.episodeId ?? undefined });
    await h.resolveCreate(value);
    h.calls.length = 0;
    return value;
  }

  it("turns progress reports into heartbeats; hidden and unload use keepalive", async () => {
    const h = harness();
    await ready(h);
    await h.lifecycle.report(report("ps-1", { reason: "interval", positionSec: 30 }));
    await h.lifecycle.report(report("ps-1", { reason: "pause", positionSec: 31, state: "paused" }));
    await h.lifecycle.report(
      report("ps-1", { reason: "hidden", positionSec: 32, state: "paused" }),
    );
    expect(h.calls).toEqual([
      'heartbeat ps-1 {"positionSec":30,"durationSec":1800,"state":"playing"}',
      'heartbeat ps-1 {"positionSec":31,"durationSec":1800,"state":"paused"}',
      'heartbeat ps-1 {"positionSec":32,"durationSec":1800,"state":"paused"} keepalive',
    ]);
    expect(h.lifecycle.getState().positionSec).toBe(32);
  });

  it("follows the server's cadence from the acknowledgement", async () => {
    const h = harness();
    await ready(h);
    h.setHeartbeat(async () => ({ heartbeatIntervalSec: 45 }));
    await h.lifecycle.report(report("ps-1"));
    expect(h.lifecycle.getState().heartbeatIntervalSec).toBe(45);
  });

  it("a revoked slot (410) stops playback with the 'ended elsewhere' screen, then goes quiet", async () => {
    const h = harness();
    await ready(h);
    h.setHeartbeat(async () => {
      throw problem("playback_session_ended");
    });
    await h.lifecycle.report(report("ps-1"));
    expect(h.lifecycle.getState()).toMatchObject({
      status: "blocked",
      block: { kind: "ended-elsewhere" },
    });
    h.calls.length = 0;
    await h.lifecycle.report(report("ps-1"));
    expect(h.calls).toEqual([]);
  });

  it("a session signed out elsewhere (401) shows the signed-out screen", async () => {
    const h = harness();
    await ready(h);
    h.setHeartbeat(async () => {
      throw problem("unauthenticated");
    });
    await h.lifecycle.report(report("ps-1"));
    expect(h.lifecycle.getState().block).toEqual({ kind: "signed-out" });
  });

  it("reports at once when the page becomes visible, so a sign-out while hidden shows right away", async () => {
    const h = harness({
      snapshot: () => report("ps-1", { positionSec: 120, state: "paused" }),
    });
    await ready(h);
    h.setHeartbeat(async () => {
      throw problem("unauthenticated");
    });
    h.lifecycle.visible();
    await flush();
    expect(h.calls).toEqual([
      'heartbeat ps-1 {"positionSec":120,"durationSec":1800,"state":"paused"}',
    ]);
    expect(h.lifecycle.getState().block).toEqual({ kind: "signed-out" });
    // Blocked: becoming visible again sends nothing more.
    h.calls.length = 0;
    h.lifecycle.visible();
    await flush();
    expect(h.calls).toEqual([]);
  });

  it("network failures keep playing, flag the connection, and report again once online", async () => {
    const h = harness({ snapshot: () => report("ps-1", { positionSec: 300 }) });
    await ready(h);
    h.setHeartbeat(async () => {
      throw networkError();
    });
    await h.lifecycle.report(report("ps-1"));
    expect(h.lifecycle.getState()).toMatchObject({ status: "ready", connection: "offline" });
    h.setHeartbeat(async () => ({ heartbeatIntervalSec: 30 }));
    h.calls.length = 0;
    h.lifecycle.online();
    await flush();
    expect(h.calls).toEqual([
      'heartbeat ps-1 {"positionSec":300,"durationSec":1800,"state":"playing"}',
    ]);
    expect(h.lifecycle.getState().connection).toBe("online");
  });

  it("an offline start retries by itself when the browser is back online", async () => {
    const h = harness();
    void h.lifecycle.open({ titleId: "t-1" });
    await h.rejectCreate(networkError());
    expect(h.lifecycle.getState().block).toEqual({ kind: "offline" });
    h.lifecycle.online();
    expect(h.api.createPlaybackSession).toHaveBeenCalledTimes(2);
  });
});

describe("switching episodes", () => {
  it("records the outgoing episode's position before starting the next one", async () => {
    let position = 1750;
    const h = harness({
      snapshot: (reason) =>
        report("ps-1", { positionSec: position, state: "ended", reason: reason as "unload" }),
    });
    void h.lifecycle.open({ titleId: "t-1", episodeId: "e-1" });
    await h.resolveCreate(session({ id: "ps-1", titleId: "t-1", episodeId: "e-1" }));
    h.calls.length = 0;
    position = 1790;
    const next = h.lifecycle.open({ titleId: "t-1", episodeId: "e-2" });
    await flush();
    expect(h.calls).toEqual([
      'heartbeat ps-1 {"positionSec":1790,"durationSec":1800,"state":"ended"} keepalive',
      'create {"titleId":"t-1","episodeId":"e-2"}',
    ]);
    await h.resolveCreate(session({ id: "ps-2", titleId: "t-1", episodeId: "e-2" }));
    await next;
    expect(h.lifecycle.getState().session?.id).toBe("ps-2");

    // The player's trailing report for the old source is not sent again, and a late 410 for it
    // does not interrupt the new episode.
    h.calls.length = 0;
    await h.lifecycle.report(report("ps-1", { reason: "unload" }));
    expect(h.calls).toEqual([]);
    expect(h.lifecycle.getState().status).toBe("ready");
  });

  it("an expected 410 for the outgoing session during a switch is not an error", async () => {
    const h = harness();
    void h.lifecycle.open({ titleId: "t-1", episodeId: "e-1" });
    await h.resolveCreate(session({ id: "ps-1", titleId: "t-1", episodeId: "e-1" }));
    void h.lifecycle.open({ titleId: "t-1", episodeId: "e-2" });
    h.setHeartbeat(async () => {
      throw problem("playback_session_ended");
    });
    await h.lifecycle.report(report("ps-1"));
    expect(h.lifecycle.getState().status).toBe("ready");
  });
});

describe("media token expiry", () => {
  const forbidden = (positionSec: number): PlayerError => ({
    code: "forbidden",
    detail: "403",
    httpStatus: 403,
    positionSec,
    fatal: true,
  });

  it("recreates the session at the failure position, transparently", async () => {
    const h = harness();
    void h.lifecycle.open({ titleId: "t-1", episodeId: "e-1" });
    await h.resolveCreate(session({ id: "ps-1", titleId: "t-1", episodeId: "e-1" }));
    h.calls.length = 0;
    void h.lifecycle.playerError(forbidden(842.5));
    await flush();
    expect(h.calls).toEqual([
      'create {"titleId":"t-1","episodeId":"e-1","startPositionSec":842.5}',
    ]);
    expect(h.lifecycle.getState().status).toBe("ready");
    await h.resolveCreate(session({ id: "ps-2", titleId: "t-1", episodeId: "e-1" }));
    expect(h.lifecycle.getState()).toMatchObject({ status: "ready", block: null });
    expect(h.lifecycle.getState().session?.id).toBe("ps-2");
  });

  it(`gives up after ${MAX_RECOVERIES} recoveries in a minute`, async () => {
    const h = harness();
    void h.lifecycle.open({ titleId: "t-1" });
    await h.resolveCreate(session({ id: "ps-0", titleId: "t-1" }));
    for (let attempt = 1; attempt <= MAX_RECOVERIES; attempt += 1) {
      void h.lifecycle.playerError(forbidden(10));
      await flush();
      await h.resolveCreate(session({ id: `ps-${attempt}`, titleId: "t-1" }));
    }
    await h.lifecycle.playerError(forbidden(10));
    expect(h.lifecycle.getState()).toMatchObject({ status: "blocked", block: { kind: "error" } });
  });

  it("a playlist 410 is told apart from a missing video with a heartbeat probe", async () => {
    const h = harness();
    void h.lifecycle.open({ titleId: "t-1" });
    await h.resolveCreate(session({ id: "ps-1", titleId: "t-1" }));
    h.setHeartbeat(async () => {
      throw problem("playback_session_ended");
    });
    await h.lifecycle.playerError({
      code: "not_found",
      detail: "410",
      httpStatus: 410,
      positionSec: 5,
      fatal: true,
    });
    expect(h.lifecycle.getState().block).toEqual({ kind: "ended-elsewhere" });
  });
});

describe("leaving", () => {
  it("frees the stream slot with the final position in one request", async () => {
    const h = harness({ snapshot: () => report("ps-1", { positionSec: 999, reason: "unload" }) });
    void h.lifecycle.open({ titleId: "t-1" });
    await h.resolveCreate(session({ id: "ps-1", titleId: "t-1" }));
    h.calls.length = 0;
    await h.lifecycle.finish();
    await flush();
    // No separate final heartbeat: it could arrive after the release and be refused (410).
    expect(h.calls).toEqual([
      'end ps-1 {"positionSec":999,"durationSec":1800,"state":"playing"} keepalive',
    ]);
    // Nothing more goes out afterwards (the player's own unload report included).
    h.calls.length = 0;
    await h.lifecycle.report(report("ps-1", { reason: "unload" }));
    expect(h.calls).toEqual([]);
  });

  it("page hide releases the slot with the last position; a back/forward restore starts again", async () => {
    const h = harness({ snapshot: () => report("ps-1", { positionSec: 640, reason: "unload" }) });
    void h.lifecycle.open({ titleId: "t-1", episodeId: "e-3" });
    await h.resolveCreate(session({ id: "ps-1", titleId: "t-1", episodeId: "e-3" }));
    await h.lifecycle.report(report("ps-1", { positionSec: 600 }));
    h.calls.length = 0;
    h.lifecycle.pageHide();
    await flush();
    expect(h.calls).toEqual([
      'end ps-1 {"positionSec":640,"durationSec":1800,"state":"playing"} keepalive',
    ]);
    h.lifecycle.pageShow(true);
    expect(h.calls.at(-1)).toBe(
      'create {"titleId":"t-1","episodeId":"e-3","startPositionSec":640}',
    );
  });
});

describe("resuming after a pause", () => {
  it("reports at once, so the time watched from the resume on counts", async () => {
    const h = harness({ snapshot: () => report("ps-1", { positionSec: 300 }) });
    void h.lifecycle.open({ titleId: "t-1" });
    await h.resolveCreate(session({ id: "ps-1", titleId: "t-1" }));
    h.calls.length = 0;
    h.lifecycle.phase("playing");
    h.lifecycle.phase("buffering");
    h.lifecycle.phase("playing");
    expect(h.calls).toEqual([]);
    h.lifecycle.phase("paused");
    h.lifecycle.phase("playing");
    await flush();
    expect(h.calls).toEqual([
      'heartbeat ps-1 {"positionSec":300,"durationSec":1800,"state":"playing"}',
    ]);
  });
});
