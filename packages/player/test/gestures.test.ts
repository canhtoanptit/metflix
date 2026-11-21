import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTapRecognizer, DEFAULT_TAP_CONFIG, zoneForPosition } from "../src/core/gestures.ts";

const scheduler = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

describe("tap zones", () => {
  it("splits the picture in thirds", () => {
    expect(zoneForPosition(10, 300)).toBe("left");
    expect(zoneForPosition(150, 300)).toBe("center");
    expect(zoneForPosition(290, 300)).toBe("right");
    expect(zoneForPosition(10, 0)).toBe("center");
  });
});

describe("tap recognizer", () => {
  let log: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    log = [];
  });
  afterEach(() => vi.useRealTimers());
  const make = () =>
    createTapRecognizer(DEFAULT_TAP_CONFIG, scheduler, {
      onSingleTap: (zone) => log.push(`single:${zone}`),
      onSeekTap: (direction, streak) => log.push(`seek:${direction}:${streak}`),
    });

  it("centre taps toggle immediately", () => {
    make().tap("center");
    expect(log).toEqual(["single:center"]);
  });

  it("a side tap is a single tap once the double-tap window passes", () => {
    const taps = make();
    taps.tap("right");
    expect(log).toEqual([]);
    vi.advanceTimersByTime(DEFAULT_TAP_CONFIG.doubleTapMs);
    expect(log).toEqual(["single:right"]);
  });

  it("double tap seeks, further taps extend the streak", () => {
    const taps = make();
    taps.tap("left");
    vi.advanceTimersByTime(100);
    taps.tap("left");
    vi.advanceTimersByTime(200);
    taps.tap("left");
    vi.advanceTimersByTime(200);
    taps.tap("left");
    expect(log).toEqual(["seek:-1:1", "seek:-1:2", "seek:-1:3"]);
    vi.advanceTimersByTime(DEFAULT_TAP_CONFIG.streakMs + 1);
    taps.tap("left");
    vi.advanceTimersByTime(DEFAULT_TAP_CONFIG.doubleTapMs);
    expect(log.at(-1)).toBe("single:left");
  });

  it("taps on different sides are two single taps", () => {
    const taps = make();
    taps.tap("left");
    taps.tap("right");
    vi.advanceTimersByTime(DEFAULT_TAP_CONFIG.doubleTapMs);
    expect(log).toEqual(["single:left", "single:right"]);
  });

  it("dispose cancels pending taps", () => {
    const taps = make();
    taps.tap("right");
    taps.dispose();
    vi.advanceTimersByTime(1000);
    expect(log).toEqual([]);
  });
});
