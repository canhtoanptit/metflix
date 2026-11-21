import type { PlaybackMarkers } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import {
  activeSkipWindow,
  CREDITS_FALLBACK_SEC,
  countdownFinished,
  creditsStartSec,
  INITIAL_MOMENTS,
  type MomentsContext,
  tickCountdown,
  updateMoments,
  viewMoments,
} from "../src/core/moments.ts";

const markers: PlaybackMarkers = {
  recap: { startSec: 2, endSec: 18 },
  intro: { startSec: 21, endSec: 43 },
  creditsStartSec: 131,
};

const ctx = (overrides: Partial<MomentsContext> = {}): MomentsContext => ({
  positionSec: 0,
  durationSec: 150,
  ended: false,
  markers,
  hasNextEpisode: true,
  autoplayNext: true,
  countdownSec: 10,
  ...overrides,
});

describe("skip windows", () => {
  it("shows Skip Recap and Skip Intro inside their windows", () => {
    expect(activeSkipWindow(markers, 1.9)).toBeNull();
    expect(activeSkipWindow(markers, 2)?.kind).toBe("recap");
    expect(activeSkipWindow(markers, 16.9)?.kind).toBe("recap");
    expect(activeSkipWindow(markers, 21.5)).toEqual({ kind: "intro", startSec: 21, endSec: 43 });
  });
  it("hides during the last second of a window", () => {
    expect(activeSkipWindow(markers, 42.2)).toBeNull();
    expect(activeSkipWindow(markers, 17.5)).toBeNull();
  });
  it("prefers the recap when windows overlap", () => {
    const overlap = { ...markers, recap: { startSec: 0, endSec: 30 } };
    expect(activeSkipWindow(overlap, 25)?.kind).toBe("recap");
  });
  it("handles missing markers", () => {
    expect(activeSkipWindow({ intro: null, recap: null, creditsStartSec: null }, 10)).toBeNull();
  });
});

describe("credits boundary", () => {
  it("uses the marker, clamped to the duration", () => {
    expect(creditsStartSec(markers, 150)).toBe(131);
    expect(creditsStartSec({ ...markers, creditsStartSec: 400 }, 150)).toBe(150);
  });
  it("falls back to shortly before the end", () => {
    expect(creditsStartSec({ ...markers, creditsStartSec: null }, 2700)).toBe(
      2700 - CREDITS_FALLBACK_SEC,
    );
  });
  it("has no fallback for very short or unknown durations", () => {
    expect(creditsStartSec({ ...markers, creditsStartSec: null }, 20)).toBeNull();
    expect(creditsStartSec({ ...markers, creditsStartSec: null }, Number.NaN)).toBeNull();
  });
});

describe("next-episode countdown", () => {
  it("starts at the credits when autoplay is on", () => {
    const before = updateMoments(INITIAL_MOMENTS, ctx({ positionSec: 130 }));
    expect(before.countdownMs).toBeNull();
    const at = updateMoments(before, ctx({ positionSec: 131 }));
    expect(at.countdownMs).toBe(10_000);
    expect(viewMoments(at, ctx({ positionSec: 131 })).nextUp).toEqual({
      mode: "countdown",
      remainingMs: 10_000,
      totalMs: 10_000,
    });
  });

  it("shows a manual card without a countdown when autoplay is off", () => {
    const state = updateMoments(INITIAL_MOMENTS, ctx({ positionSec: 135, autoplayNext: false }));
    expect(state.countdownMs).toBeNull();
    expect(viewMoments(state, ctx({ positionSec: 135, autoplayNext: false })).nextUp).toEqual({
      mode: "manual",
    });
  });

  it("ticks down, finishes once, and never fires twice", () => {
    let state = updateMoments(INITIAL_MOMENTS, ctx({ positionSec: 132 }));
    state = tickCountdown(state, 4000);
    expect(state.countdownMs).toBe(6000);
    state = tickCountdown(state, 9000);
    expect(state.countdownMs).toBe(0);
    expect(countdownFinished(state)).toBe(true);
    state = { ...state, nextRequested: true, countdownMs: null };
    expect(countdownFinished(state)).toBe(false);
    expect(updateMoments(state, ctx({ positionSec: 140 }))).toBe(state);
    expect(viewMoments(state, ctx({ positionSec: 140 })).nextUp).toBeNull();
  });

  it("'Watch credits' hides the card until the end, which brings it back", () => {
    let state = updateMoments(INITIAL_MOMENTS, ctx({ positionSec: 132 }));
    state = { ...state, creditsDismissed: true, countdownMs: null };
    state = updateMoments(state, ctx({ positionSec: 140 }));
    expect(viewMoments(state, ctx({ positionSec: 140 })).nextUp).toBeNull();
    state = updateMoments(state, ctx({ positionSec: 150, ended: true }));
    expect(state.creditsDismissed).toBe(false);
    expect(viewMoments(state, ctx({ positionSec: 150, ended: true })).nextUp?.mode).toBe(
      "countdown",
    );
  });

  it("seeking back before the credits re-arms everything", () => {
    let state = updateMoments(INITIAL_MOMENTS, ctx({ positionSec: 132 }));
    state = tickCountdown(state, 3000);
    state = updateMoments(state, ctx({ positionSec: 60 }));
    expect(state).toBe(INITIAL_MOMENTS);
  });
});

describe("end screen (last episode / movie)", () => {
  const last = (overrides: Partial<MomentsContext> = {}) =>
    ctx({ hasNextEpisode: false, ...overrides });
  it("appears at the credits marker and after the end", () => {
    expect(viewMoments(INITIAL_MOMENTS, last({ positionSec: 120 })).endScreen).toBeNull();
    expect(viewMoments(INITIAL_MOMENTS, last({ positionSec: 131 })).endScreen).toBe("credits");
    expect(viewMoments(INITIAL_MOMENTS, last({ positionSec: 150, ended: true })).endScreen).toBe(
      "ended",
    );
  });
  it("is dismissed by 'Watch credits' until the end", () => {
    const dismissed = { ...INITIAL_MOMENTS, creditsDismissed: true };
    expect(viewMoments(dismissed, last({ positionSec: 140 })).endScreen).toBeNull();
    expect(viewMoments(dismissed, last({ positionSec: 150, ended: true })).endScreen).toBe("ended");
  });
  it("waits for the real end when there is no credits marker", () => {
    const unmarked = { ...markers, creditsStartSec: null };
    expect(
      viewMoments(INITIAL_MOMENTS, last({ markers: unmarked, positionSec: 145 })).endScreen,
    ).toBeNull();
    expect(
      viewMoments(INITIAL_MOMENTS, last({ markers: unmarked, positionSec: 150, ended: true }))
        .endScreen,
    ).toBe("ended");
  });
  it("never shows skip buttons after the end", () => {
    expect(viewMoments(INITIAL_MOMENTS, ctx({ positionSec: 22, ended: true })).skip).toBeNull();
  });
});
