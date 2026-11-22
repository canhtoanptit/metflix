import { describe, expect, it } from "vitest";
import {
  classifyHlsError,
  classifyMediaElementError,
  END_OF_STREAM_SLACK_SEC,
  MAX_MEDIA_RECOVERIES,
  MAX_NETWORK_RETRIES,
  MAX_STALL_NUDGES,
  retryDelayMs,
} from "../src/core/errors.ts";

const fresh = { networkRetries: 0, mediaRecoveries: 0, stallNudges: 0 };

describe("hls.js error recovery policy", () => {
  it("ignores non-fatal errors", () => {
    expect(
      classifyHlsError({ type: "networkError", details: "fragLoadError", fatal: false }, fresh),
    ).toEqual({
      action: "ignore",
    });
  });

  it("nudges a playhead stuck with data buffered ahead, then recovers the media, then gives up", () => {
    // hls.js only reports this (non-fatal, once per stall) and never nudges inside one range.
    const stuck = {
      type: "mediaError",
      details: "bufferStalledError",
      fatal: false,
      buffer: 149.9,
    };
    expect(classifyHlsError(stuck, fresh)).toEqual({ action: "nudge" });
    expect(classifyHlsError(stuck, { ...fresh, stallNudges: MAX_STALL_NUDGES - 1 })).toEqual({
      action: "nudge",
    });
    expect(classifyHlsError(stuck, { ...fresh, stallNudges: MAX_STALL_NUDGES })).toEqual({
      action: "recover-media",
      swapAudioCodec: false,
    });
    expect(
      classifyHlsError(stuck, {
        ...fresh,
        stallNudges: MAX_STALL_NUDGES,
        mediaRecoveries: MAX_MEDIA_RECOVERIES,
      }),
    ).toEqual({ action: "ignore" });
  });

  it("leaves a starved playhead (nothing buffered ahead) to hls.js", () => {
    expect(
      classifyHlsError(
        { type: "mediaError", details: "bufferStalledError", fatal: false, buffer: 0.2 },
        fresh,
      ),
    ).toEqual({ action: "ignore" });
  });

  it("finishes a title stalled just short of its end, whatever is buffered", () => {
    // Seen under load after a seek near the end: hls.js never ended the MediaSource and the
    // element waited at 149.95 of 150 with 0.05 s buffered ahead.
    const stalled = {
      type: "mediaError",
      details: "bufferStalledError",
      fatal: false,
      buffer: 0.05,
    };
    expect(classifyHlsError(stalled, fresh, { positionSec: 149.95, durationSec: 150 })).toEqual({
      action: "finish",
    });
    expect(
      classifyHlsError(stalled, fresh, {
        positionSec: 150 - END_OF_STREAM_SLACK_SEC,
        durationSec: 150,
      }),
    ).toEqual({ action: "finish" });
    // Short of the slack it is an ordinary stall: starvation is left to hls.js.
    expect(classifyHlsError(stalled, fresh, { positionSec: 149, durationSec: 150 })).toEqual({
      action: "ignore",
    });
    // Live streams never end; no metadata yet means no end to seek to.
    for (const durationSec of [Number.POSITIVE_INFINITY, Number.NaN, 0]) {
      expect(classifyHlsError(stalled, fresh, { positionSec: 0, durationSec })).toEqual({
        action: "ignore",
      });
    }
    // Other non-fatal errors near the end are still ignored.
    expect(
      classifyHlsError({ type: "networkError", details: "fragLoadError", fatal: false }, fresh, {
        positionSec: 149.95,
        durationSec: 150,
      }),
    ).toEqual({ action: "ignore" });
  });

  it("surfaces expired tokens immediately, even when hls.js would retry", () => {
    expect(
      classifyHlsError(
        { type: "networkError", details: "fragLoadError", fatal: false, response: { code: 403 } },
        fresh,
      ),
    ).toEqual({ action: "fatal", code: "forbidden", httpStatus: 403 });
  });

  it("maps a missing manifest to not_found", () => {
    expect(
      classifyHlsError(
        {
          type: "networkError",
          details: "manifestLoadError",
          fatal: true,
          response: { code: 404 },
        },
        fresh,
      ),
    ).toEqual({ action: "fatal", code: "not_found", httpStatus: 404 });
  });

  it("retries network failures with back-off, then gives up", () => {
    const error = {
      type: "networkError",
      details: "levelLoadError",
      fatal: true,
      response: { code: 0 },
    };
    expect(classifyHlsError(error, fresh)).toEqual({ action: "retry-network", delayMs: 1000 });
    expect(classifyHlsError(error, { ...fresh, networkRetries: 2 })).toEqual({
      action: "retry-network",
      delayMs: 4000,
    });
    expect(classifyHlsError(error, { ...fresh, networkRetries: MAX_NETWORK_RETRIES })).toEqual({
      action: "fatal",
      code: "network",
      httpStatus: null,
    });
    expect(retryDelayMs(0)).toBe(1000);
  });

  it("recovers media errors, then swaps the audio codec, then gives up", () => {
    const error = { type: "mediaError", details: "bufferAppendError", fatal: true };
    expect(classifyHlsError(error, fresh)).toEqual({
      action: "recover-media",
      swapAudioCodec: false,
    });
    expect(classifyHlsError(error, { ...fresh, mediaRecoveries: 1 })).toEqual({
      action: "recover-media",
      swapAudioCodec: true,
    });
    expect(
      classifyHlsError(error, { ...fresh, mediaRecoveries: MAX_MEDIA_RECOVERIES }),
    ).toMatchObject({
      action: "fatal",
      code: "media",
    });
  });

  it("treats incompatible codecs as unsupported", () => {
    expect(
      classifyHlsError(
        { type: "mediaError", details: "manifestIncompatibleCodecsError", fatal: true },
        fresh,
      ),
    ).toMatchObject({ action: "fatal", code: "unsupported" });
  });

  it("reads the status from the XHR when the response lacks it", () => {
    expect(
      classifyHlsError(
        {
          type: "networkError",
          details: "fragLoadError",
          fatal: true,
          networkDetails: { status: 401 },
        },
        fresh,
      ),
    ).toMatchObject({ code: "forbidden", httpStatus: 401 });
  });
});

describe("media element errors", () => {
  it("maps MediaError codes", () => {
    expect(classifyMediaElementError(1)).toBeNull();
    expect(classifyMediaElementError(2)).toBe("network");
    expect(classifyMediaElementError(3)).toBe("media");
    expect(classifyMediaElementError(4)).toBe("unsupported");
    expect(classifyMediaElementError(9)).toBe("unknown");
  });
});
