import { describe, expect, it } from "vitest";
import {
  bufferedEndAt,
  countdownRunning,
  createInitialState,
  heartbeatState,
  isBuffering,
  type PlayerAction,
  type PlayerState,
  playerReducer,
  type SourceInfo,
  selectMomentsView,
} from "../src/core/state.ts";

const source: SourceInfo = {
  key: "ps-1",
  durationHint: 150,
  markers: { recap: null, intro: { startSec: 21, endSec: 43 }, creditsStartSec: 131 },
  textTracks: [],
  trickPlay: null,
  hasNextEpisode: true,
  autoplayNext: true,
  countdownSec: 10,
  maxVideoHeight: 1080,
};

const run = (actions: PlayerAction[], from: PlayerState = createInitialState()) =>
  actions.reduce(playerReducer, from);

const loaded = (autoplay = true) =>
  run([{ type: "source/load", source, startPositionSec: 12, autoplay }]);

describe("player state machine", () => {
  it("loads a source and resets per-source state, keeping preferences", () => {
    const state = run(
      [
        { type: "media/volume", volume: 0.4, muted: true },
        { type: "media/time", currentTime: 99 },
        { type: "source/load", source, startPositionSec: 12, autoplay: true },
      ],
      createInitialState(),
    );
    expect(state).toMatchObject({
      phase: "loading",
      playIntent: true,
      currentTime: 12,
      duration: 150,
      volume: 0.4,
      muted: true,
      preferences: { volume: 0.4, muted: true },
    });
  });

  it("goes loading → playing → paused → playing → buffering → playing → ended", () => {
    let state = loaded();
    expect(heartbeatState(state)).toBe("buffering");
    state = playerReducer(state, { type: "media/playing" });
    expect(state.phase).toBe("playing");
    expect(heartbeatState(state)).toBe("playing");
    state = playerReducer(state, { type: "media/pause" });
    expect(state).toMatchObject({ phase: "paused", playIntent: false });
    expect(heartbeatState(state)).toBe("paused");
    state = run(
      [{ type: "media/play" }, { type: "media/playing" }, { type: "media/waiting" }],
      state,
    );
    expect(state.phase).toBe("buffering");
    expect(isBuffering(state)).toBe(true);
    state = run([{ type: "media/playing" }, { type: "media/ended" }], state);
    expect(state.phase).toBe("ended");
    expect(heartbeatState(state)).toBe("ended");
  });

  it("settles into paused when data arrives without autoplay", () => {
    let state = loaded(false);
    expect(isBuffering(state)).toBe(true);
    state = playerReducer(state, { type: "media/first-frame" });
    expect(state.phase).toBe("paused");
    expect(isBuffering(state)).toBe(false);
  });

  it("records autoplay refusal", () => {
    const state = playerReducer(loaded(), { type: "media/autoplay-blocked" });
    expect(state).toMatchObject({ autoplayBlocked: true, playIntent: false, phase: "paused" });
    expect(playerReducer(state, { type: "media/play" }).autoplayBlocked).toBe(false);
  });

  it("seeking away from the end leaves the ended state", () => {
    const ended = run(
      [{ type: "media/playing" }, { type: "media/pause" }, { type: "media/ended" }],
      loaded(),
    );
    expect(playerReducer(ended, { type: "media/seeking", target: 10 }).phase).toBe("paused");
  });

  it("errors are terminal until a new load", () => {
    const error = {
      code: "network" as const,
      detail: "x",
      httpStatus: null,
      positionSec: 30,
      fatal: true as const,
    };
    let state = run([{ type: "media/playing" }, { type: "engine/error", error }], loaded());
    expect(state).toMatchObject({ phase: "error", playIntent: false });
    state = run([{ type: "media/playing" }, { type: "media/time", currentTime: 99 }], state);
    expect(state.phase).toBe("error");
    expect(state.currentTime).toBe(12);
    expect(
      run([{ type: "source/load", source, startPositionSec: 30, autoplay: true }], state).error,
    ).toBeNull();
  });

  it("menus close when the controls hide", () => {
    let state = playerReducer(loaded(), { type: "ui/menu", menu: "speed" });
    state = playerReducer(state, { type: "ui/idle", controlsVisible: false, pausedIdle: false });
    expect(state.menu).toBeNull();
  });

  it("rate and volume changes update preferences", () => {
    const state = run(
      [
        { type: "media/rate", rate: 1.5 },
        { type: "media/volume", volume: 0.333, muted: false },
      ],
      loaded(),
    );
    expect(state.preferences).toMatchObject({ playbackRate: 1.5, volume: 0.33 });
  });

  it("drives the countdown from time updates and ticks", () => {
    let state = run(
      [{ type: "media/playing" }, { type: "media/time", currentTime: 131.5 }],
      loaded(),
    );
    expect(state.moments.countdownMs).toBe(10_000);
    expect(countdownRunning(state)).toBe(true);
    expect(selectMomentsView(state)?.nextUp?.mode).toBe("countdown");
    state = playerReducer(state, { type: "moments/tick", elapsedMs: 2500 });
    expect(state.moments.countdownMs).toBe(7500);
    expect(countdownRunning(playerReducer(state, { type: "media/pause" }))).toBe(false);
    expect(countdownRunning(playerReducer(state, { type: "ui/panel", panel: "episodes" }))).toBe(
      false,
    );
    state = playerReducer(state, { type: "moments/next-requested" });
    expect(state.moments).toMatchObject({ nextRequested: true, countdownMs: null });
    expect(selectMomentsView(state)?.nextUp).toBeNull();
  });

  it("host overlay closes menus and panels", () => {
    let state = run(
      [
        { type: "ui/panel", panel: "episodes" },
        { type: "ui/menu", menu: "quality" },
      ],
      loaded(),
    );
    state = playerReducer(state, { type: "ui/blocked", value: true });
    expect(state).toMatchObject({ blocked: true, menu: null, panel: null });
  });

  it("finds the buffered end around a time", () => {
    const ranges = [
      { start: 0, end: 20 },
      { start: 40, end: 70 },
    ];
    expect(bufferedEndAt(ranges, 10)).toBe(20);
    expect(bufferedEndAt(ranges, 39.8)).toBe(70);
    expect(bufferedEndAt(ranges, 30)).toBe(0);
  });
});
