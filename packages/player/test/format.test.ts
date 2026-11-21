import { describe, expect, it } from "vitest";
import {
  formatBitrate,
  formatEpisodeCode,
  formatPlaybackTime,
  formatRate,
  formatRemainingTime,
  formatRuntime,
  formatSpokenDuration,
} from "../src/core/format.ts";

describe("formatPlaybackTime", () => {
  it.each([
    [0, "0:00"],
    [9.9, "0:09"],
    [65, "1:05"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3725, "1:02:05"],
    [Number.NaN, "0:00"],
    [Number.POSITIVE_INFINITY, "0:00"],
    [-5, "0:00"],
  ])("%s → %s", (seconds, expected) => {
    expect(formatPlaybackTime(seconds)).toBe(expected);
  });
});

describe("formatRemainingTime", () => {
  it("counts down and never goes negative", () => {
    expect(formatRemainingTime(0, 150)).toBe("-2:30");
    expect(formatRemainingTime(149.2, 150)).toBe("-0:01");
    expect(formatRemainingTime(150, 150)).toBe("-0:00");
    expect(formatRemainingTime(200, 150)).toBe("-0:00");
    expect(formatRemainingTime(10, Number.NaN)).toBe("-0:00");
  });
});

describe("formatSpokenDuration", () => {
  it.each([
    [0, "0 seconds"],
    [1, "1 second"],
    [61, "1 minute 1 second"],
    [3600, "1 hour"],
    [7322, "2 hours 2 minutes 2 seconds"],
  ])("%s → %s", (seconds, expected) => {
    expect(formatSpokenDuration(seconds)).toBe(expected);
  });
});

describe("small formatters", () => {
  it("formats runtimes", () => {
    expect(formatRuntime(52)).toBe("52s");
    expect(formatRuntime(2700)).toBe("45m");
    expect(formatRuntime(3900)).toBe("1h 5m");
    expect(formatRuntime(7200)).toBe("2h");
  });
  it("formats episode codes, rates and bitrates", () => {
    expect(formatEpisodeCode(2, 7)).toBe("S2:E7");
    expect(formatRate(1)).toBe("Normal");
    expect(formatRate(1.25)).toBe("1.25×");
    expect(formatRate(0.5, "1×")).toBe("0.5×");
    expect(formatBitrate(5_213_540)).toBe("5.2 Mbps");
    expect(formatBitrate(728_494)).toBe("728 kbps");
    expect(formatBitrate(0)).toBe("");
  });
});
