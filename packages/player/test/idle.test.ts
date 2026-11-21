import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleTracker, DEFAULT_IDLE_CONFIG, type IdleState } from "../src/core/idle.ts";

const scheduler = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

describe("controls idle logic", () => {
  let changes: IdleState[];
  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = () =>
    createIdleTracker(DEFAULT_IDLE_CONFIG, scheduler, (state) => changes.push(state));

  it("hides 3 s after the last pointer activity while playing", () => {
    const idle = make();
    idle.setPlaying(true);
    idle.activity("pointer");
    vi.advanceTimersByTime(2900);
    expect(idle.state.controlsVisible).toBe(true);
    idle.activity("pointer");
    vi.advanceTimersByTime(2900);
    expect(idle.state.controlsVisible).toBe(true);
    vi.advanceTimersByTime(200);
    expect(idle.state).toEqual({ controlsVisible: false, pausedIdle: false });
  });

  it("waits longer after a touch", () => {
    const idle = make();
    idle.setPlaying(true);
    idle.activity("touch");
    vi.advanceTimersByTime(3500);
    expect(idle.state.controlsVisible).toBe(true);
    vi.advanceTimersByTime(600);
    expect(idle.state.controlsVisible).toBe(false);
  });

  it("keeps controls while paused, then hands over to the paused overlay", () => {
    const idle = make();
    idle.setPlaying(true);
    vi.advanceTimersByTime(5000);
    expect(idle.state.controlsVisible).toBe(false);
    idle.setPlaying(false);
    expect(idle.state).toEqual({ controlsVisible: true, pausedIdle: false });
    vi.advanceTimersByTime(7900);
    expect(idle.state.controlsVisible).toBe(true);
    vi.advanceTimersByTime(200);
    expect(idle.state).toEqual({ controlsVisible: false, pausedIdle: true });
    idle.activity("pointer");
    expect(idle.state).toEqual({ controlsVisible: true, pausedIdle: false });
  });

  it("resuming from the paused overlay goes straight back to the picture", () => {
    const idle = make();
    idle.activity("pointer");
    vi.advanceTimersByTime(9000);
    expect(idle.state.pausedIdle).toBe(true);
    idle.setPlaying(true);
    expect(idle.state).toEqual({ controlsVisible: false, pausedIdle: false });
  });

  it("holds keep controls up and stop timers until released", () => {
    const idle = make();
    idle.setPlaying(true);
    idle.setHold("menu", true);
    idle.setHold("hover", true);
    vi.advanceTimersByTime(60_000);
    expect(idle.state.controlsVisible).toBe(true);
    idle.hideNow();
    expect(idle.state.controlsVisible).toBe(true);
    idle.setHold("menu", false);
    vi.advanceTimersByTime(60_000);
    expect(idle.state.controlsVisible).toBe(true);
    idle.setHold("hover", false);
    vi.advanceTimersByTime(3000);
    expect(idle.state.controlsVisible).toBe(false);
  });

  it("tap toggles, pointer leave hides immediately", () => {
    const idle = make();
    idle.setPlaying(true);
    idle.toggle();
    expect(idle.state.controlsVisible).toBe(false);
    idle.toggle();
    expect(idle.state.controlsVisible).toBe(true);
    idle.hideNow();
    expect(idle.state.controlsVisible).toBe(false);
  });

  it("only reports real changes and stops after dispose", () => {
    const idle = make();
    idle.setPlaying(true);
    idle.activity("pointer");
    idle.activity("pointer");
    expect(changes).toEqual([]);
    idle.dispose();
    vi.advanceTimersByTime(10_000);
    expect(changes).toEqual([]);
  });
});
