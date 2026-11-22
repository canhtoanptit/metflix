import { describe, expect, it } from "vitest";
import {
  formatTimeLeft,
  formatTimeLeftSpoken,
  progressFraction,
  timeLeftSec,
} from "../src/time-left.ts";

const at = (positionSec: number, durationSec: number) => ({ positionSec, durationSec });

describe("time left", () => {
  it("says what is left in minutes, hours and minutes, or hours", () => {
    expect(formatTimeLeft(at(300, 1020))).toBe("12m left");
    expect(formatTimeLeft(at(0, 3900))).toBe("1h 5m left");
    expect(formatTimeLeft(at(600, 7800))).toBe("2h left");
    expect(formatTimeLeft(at(0, 59 * 60 + 50))).toBe("1h left");
  });

  it("counts seconds under two minutes, and never reads 0m with time left", () => {
    expect(formatTimeLeft(at(0, 119))).toBe("1m 59s left");
    expect(formatTimeLeft(at(0, 105))).toBe("1m 45s left");
    expect(formatTimeLeft(at(0, 60))).toBe("1m left");
    expect(formatTimeLeft(at(20, 60))).toBe("40s left");
    expect(formatTimeLeft(at(59.4, 60))).toBe("1s left");
    expect(formatTimeLeft(at(0, 120))).toBe("2m left");
  });

  it("never rounds a short remainder away (the old '1 of 1m')", () => {
    // 55 s into a 70 s episode: 15 s left, not "1 of 1m".
    expect(formatTimeLeft(at(55, 70))).toBe("15s left");
    // 59 of 60 minutes: one minute left, not "60 of 60m".
    expect(formatTimeLeft(at(59 * 60, 3600))).toBe("1m left");
  });

  it("is finished at or past the end, and safe with unknown durations", () => {
    expect(formatTimeLeft(at(60, 60))).toBe("Finished");
    expect(formatTimeLeft(at(90, 60))).toBe("Finished");
    expect(formatTimeLeft(at(10, 0))).toBe("Finished");
    expect(timeLeftSec(at(Number.NaN, 100))).toBe(100);
    expect(progressFraction(at(10, 0))).toBe(0);
  });

  it("keeps the bar and the label on the same numbers", () => {
    for (const [position, duration] of [
      [0, 1440],
      [55, 70],
      [1320, 3180],
      [3540, 3600],
    ] as const) {
      const fraction = progressFraction(at(position, duration));
      const left = timeLeftSec(at(position, duration));
      expect(fraction).toBeCloseTo(position / duration);
      expect(left).toBeCloseTo(duration * (1 - fraction));
    }
  });

  it("completed is finished under a full bar, wherever the saved position stopped", () => {
    // The server marks completion at the credits: position short of the end.
    const credits = { positionSec: 2_520, durationSec: 2_700, completed: true };
    expect(formatTimeLeft(credits)).toBe("Finished");
    expect(formatTimeLeftSpoken(credits)).toBe("Finished");
    expect(progressFraction(credits)).toBe(1);
    expect(timeLeftSec(credits)).toBe(0);
    // Not completed: the same position still has time left.
    expect(formatTimeLeft({ ...credits, completed: false })).toBe("3m left");
    expect(progressFraction({ ...credits, completed: false })).toBeCloseTo(2_520 / 2_700);
    // Completed with nothing known about the duration is still finished.
    expect(progressFraction({ positionSec: 0, durationSec: 0, completed: true })).toBe(1);
  });

  it("spells it out for screen readers", () => {
    expect(formatTimeLeftSpoken(at(300, 1020))).toBe("12 minutes left");
    expect(formatTimeLeftSpoken(at(0, 105))).toBe("1 minute 45 seconds left");
    expect(formatTimeLeftSpoken(at(0, 3900))).toBe("1 hour 5 minutes left");
  });
});
