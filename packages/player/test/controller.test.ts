// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ControllerHost,
  type LoadRequest,
  PlayerController,
} from "../src/controller/controller.ts";
import { createMemoryPreferenceStorage } from "../src/core/preferences.ts";
import type { SourceInfo } from "../src/core/state.ts";
import { createFakeEngineFactory, createFakeMedia, type FakeMedia, flush } from "./fakes.ts";

const source = (key: string, overrides: Partial<SourceInfo> = {}): SourceInfo => ({
  key,
  durationHint: 150,
  markers: { recap: null, intro: { startSec: 21, endSec: 43 }, creditsStartSec: 131 },
  textTracks: [
    {
      id: "en",
      language: "en",
      label: "English",
      kind: "subtitles",
      url: "/en.vtt",
      default: false,
      forced: false,
    },
    {
      id: "es",
      language: "es",
      label: "Español",
      kind: "subtitles",
      url: "/es.vtt",
      default: false,
      forced: false,
    },
  ],
  trickPlay: null,
  hasNextEpisode: true,
  autoplayNext: true,
  countdownSec: 5,
  maxVideoHeight: 720,
  ...overrides,
});

const request = (key: string, overrides: Partial<LoadRequest> = {}): LoadRequest => ({
  key,
  sessionId: key,
  url: `/media/t/vod/${key}/master.m3u8`,
  source: source(key),
  startPositionSec: 0,
  autoplay: true,
  enginePreference: "auto",
  ...overrides,
});

describe("PlayerController", () => {
  let media: FakeMedia;
  let root: HTMLElement;
  let fakes: ReturnType<typeof createFakeEngineFactory>;
  let host: Required<ControllerHost>;
  let controller: PlayerController;
  let storage: ReturnType<typeof createMemoryPreferenceStorage>;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    media = createFakeMedia();
    root = document.createElement("div");
    document.body.append(root);
    root.append(media);
    fakes = createFakeEngineFactory();
    storage = createMemoryPreferenceStorage({ subtitleLanguage: "es", volume: 0.5 });
    host = {
      onProgress: vi.fn(),
      onStateChange: vi.fn(),
      onEnded: vi.fn(),
      onNextEpisode: vi.fn(),
      onQualityChange: vi.fn(),
      onError: vi.fn(),
      onPreferencesChange: vi.fn(),
      onFullscreenChange: vi.fn(),
    };
    controller = new PlayerController({
      engineFactory: fakes.factory,
      resolveEngine: async () => "hls.js",
      storage,
    });
    controller.host = host;
  });

  afterEach(() => {
    controller.destroy();
    root.remove();
    vi.useRealTimers();
  });

  const start = async (req = request("ep1")) => {
    controller.attach(media, root);
    controller.load(req);
    await flush();
  };

  it("hands the engine the URL, resume position, plan cap and audio preference, then autoplays", async () => {
    await start(request("ep1", { startPositionSec: 42 }));
    expect(fakes.engines).toHaveLength(1);
    expect(fakes.engines[0]?.config).toMatchObject({
      url: "/media/t/vod/ep1/master.m3u8",
      startPositionSec: 42,
      maxVideoHeight: 720,
    });
    expect(media.play).toHaveBeenCalled();
    expect(controller.state.phase).toBe("playing");
    expect(host.onStateChange).toHaveBeenLastCalledWith("playing");
  });

  it("applies remembered preferences: volume and subtitle language", async () => {
    await start();
    expect(media.volume).toBe(0.5);
    expect(controller.state.textTrackId).toBe("es");
    expect(media.querySelectorAll("track")).toHaveLength(2);
  });

  it("shows the play button when autoplay is refused", async () => {
    media.blockAutoplay = true;
    await start();
    expect(controller.state.autoplayBlocked).toBe(true);
    expect(controller.state.phase).toBe("paused");
    media.blockAutoplay = false;
    await controller.play("pointer");
    expect(controller.state.autoplayBlocked).toBe(false);
  });

  it("reports progress at the host cadence and on pause, throttled", async () => {
    controller.setProgressInterval(10);
    await start();
    media.setTime(5);
    vi.advanceTimersByTime(10_000);
    expect(host.onProgress).toHaveBeenLastCalledWith({
      sessionId: "ep1",
      positionSec: 5,
      durationSec: 150,
      state: "playing",
      reason: "interval",
    });
    controller.pause("pointer");
    expect(host.onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: "pause", state: "paused" }),
    );
    const calls = vi.mocked(host.onProgress).mock.calls.length;
    void controller.play("pointer");
    await flush();
    controller.pause("pointer");
    expect(vi.mocked(host.onProgress).mock.calls.length).toBe(calls);
    // Throttled, not dropped: the pause is reported once the window ends.
    vi.advanceTimersByTime(2000);
    expect(vi.mocked(host.onProgress).mock.calls.length).toBe(calls + 1);
    expect(host.onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: "pause", state: "paused" }),
    );
  });

  it("a pause right after a seek report still reaches the host, with the state of that moment", async () => {
    // Seen in the gate: the seek report for `?t=40` went out, the member paused 5 ms later, and
    // the pause was never reported (the server thought the stream played on).
    await start();
    media.setTime(40);
    media.emit("seeking");
    media.emit("seeked");
    vi.advanceTimersByTime(1200);
    expect(host.onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: "seek", state: "playing", positionSec: 40 }),
    );
    const calls = vi.mocked(host.onProgress).mock.calls.length;
    vi.advanceTimersByTime(5);
    controller.pause("keyboard");
    media.setTime(40.2);
    expect(vi.mocked(host.onProgress).mock.calls.length).toBe(calls);
    vi.advanceTimersByTime(2000);
    expect(vi.mocked(host.onProgress).mock.calls.length).toBe(calls + 1);
    expect(host.onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: "pause", state: "paused", positionSec: 40.2 }),
    );
  });

  it("a report still waiting for its window is superseded by the session's last word", async () => {
    await start();
    controller.pause("pointer");
    void controller.play("pointer");
    await flush();
    controller.pause("pointer");
    const calls = vi.mocked(host.onProgress).mock.calls.length;
    controller.load(request("ep2"));
    expect(host.onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "ep1", reason: "unload" }),
    );
    await flush();
    vi.advanceTimersByTime(2000);
    // Only the unload: nothing more for ep1, and nothing stale reported for ep2.
    expect(vi.mocked(host.onProgress).mock.calls.length).toBe(calls + 1);
  });

  it("swaps sources in place: final report for the old session, fresh engine, state reset", async () => {
    await start();
    media.setTime(100);
    controller.load(request("ep2"));
    expect(host.onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "ep1", reason: "unload", positionSec: 100 }),
    );
    await flush();
    expect(fakes.engines[0]?.destroyed).toBe(true);
    expect(fakes.engines).toHaveLength(2);
    expect(controller.state.source?.key).toBe("ep2");
    expect(media.querySelectorAll("track")).toHaveLength(2);
  });

  it("the same session with new options updates in place without reloading", async () => {
    await start();
    controller.load(request("ep1", { source: source("ep1", { autoplayNext: false }) }));
    await flush();
    expect(fakes.engines).toHaveLength(1);
    expect(controller.state.source?.autoplayNext).toBe(false);
  });

  it("detach releases the engine, tracks, media source and timers", async () => {
    controller.setProgressInterval(1);
    await start();
    controller.detach();
    expect(fakes.engines[0]?.destroyed).toBe(true);
    expect(media.querySelectorAll("track")).toHaveLength(0);
    expect(media.hasAttribute("src")).toBe(false);
    expect(media.load).toHaveBeenCalled();
    const reports = vi.mocked(host.onProgress).mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(vi.mocked(host.onProgress).mock.calls.length).toBe(reports);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an engine that resolves after detach is destroyed, not used", async () => {
    let release: () => void = () => {};
    controller = new PlayerController({
      engineFactory: fakes.factory,
      resolveEngine: () =>
        new Promise((resolve) => {
          release = () => resolve("hls.js");
        }),
    });
    controller.attach(media, root);
    controller.load(request("ep1"));
    controller.detach();
    release();
    await flush();
    expect(fakes.engines).toHaveLength(0);
  });

  it("runs the next-episode countdown at the credits and asks the host once", async () => {
    await start();
    media.setTime(132);
    expect(controller.state.moments.countdownMs).toBe(5000);
    vi.advanceTimersByTime(5200);
    expect(host.onNextEpisode).toHaveBeenCalledTimes(1);
    expect(host.onNextEpisode).toHaveBeenCalledWith("autoplay");
    vi.advanceTimersByTime(10_000);
    expect(host.onNextEpisode).toHaveBeenCalledTimes(1);
  });

  it("pauses the countdown while paused", async () => {
    await start();
    media.setTime(132);
    controller.pause("pointer");
    vi.advanceTimersByTime(20_000);
    expect(host.onNextEpisode).not.toHaveBeenCalled();
  });

  it("keyboard shortcuts drive the element and leave unknown keys alone", async () => {
    await start();
    media.setTime(30);
    expect(controller.handleKey({ key: "ArrowRight" })).toBe(true);
    expect(media.currentTime).toBe(40);
    expect(controller.handleKey({ key: "ArrowDown" })).toBe(true);
    expect(controller.handleKey({ key: "ArrowDown" })).toBe(true);
    expect(media.volume).toBeCloseTo(0.3, 5);
    vi.mocked(media.pause).mockClear();
    vi.mocked(media.play).mockClear();
    expect(controller.handleKey({ key: " " })).toBe(true);
    expect(controller.handleKey({ key: "k" })).toBe(true);
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(controller.handleKey({ key: "c" })).toBe(true);
    expect(controller.state.textTrackId).toBeNull();
    expect(controller.handleKey({ key: "c" })).toBe(true);
    expect(controller.state.textTrackId).toBe("es");
    expect(controller.handleKey({ key: "Escape" })).toBe(false);
    expect(controller.handleKey({ key: "q" })).toBe(false);
    media.setTime(25);
    expect(controller.handleKey({ key: "s" })).toBe(true);
    expect(media.currentTime).toBe(43);
  });

  it("persists preference changes and reports them", async () => {
    await start();
    controller.selectTextTrack("en", "pointer");
    controller.setRate(1.25, "pointer");
    expect(storage.value).toMatchObject({ subtitleLanguage: "en", playbackRate: 1.25 });
    expect(host.onPreferencesChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ subtitleLanguage: "en", playbackRate: 1.25 }),
      ["playbackRate"],
    );
  });

  it("surfaces fatal engine errors with the failure position, and retries in place", async () => {
    await start();
    media.setTime(77);
    fakes.engines[0]?.events.fatal({ code: "forbidden", detail: "fragLoadError", httpStatus: 403 });
    expect(controller.state.phase).toBe("error");
    expect(host.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "forbidden", httpStatus: 403, positionSec: 77, fatal: true }),
    );
    controller.retry();
    await flush();
    expect(fakes.engines).toHaveLength(2);
    expect(fakes.engines[1]?.config.startPositionSec).toBe(77);
  });

  it("reports where the element is on failure, not the last timeupdate sample", async () => {
    await start();
    media.setTime(3);
    // Playback moved on since the last timeupdate (they come every ~250 ms).
    media.advance(0.2);
    fakes.engines[0]?.events.fatal({ code: "forbidden", detail: "fragLoadError", httpStatus: 403 });
    expect(host.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "forbidden", positionSec: 3.2 }),
    );
  });

  it("ignores events from a superseded engine", async () => {
    await start();
    const stale = fakes.engines[0];
    controller.load(request("ep2"));
    await flush();
    stale?.events.fatal({ code: "network", detail: "late", httpStatus: null });
    stale?.events.levels([{ id: 0, width: 1, height: 1, bitrate: 1 }], true);
    expect(controller.state.error).toBeNull();
    expect(controller.state.qualityLevels).toEqual([]);
  });

  it("quality selection goes to the engine and is reported by height", async () => {
    await start();
    const engine = fakes.engines[0];
    engine?.events.levels(
      [
        { id: 0, width: 640, height: 360, bitrate: 700_000 },
        { id: 1, width: 1280, height: 720, bitrate: 3_000_000 },
      ],
      true,
    );
    engine?.events.levelSwitched(0);
    controller.setQuality(1, "pointer");
    expect(engine?.setQuality).toHaveBeenCalledWith(1);
    engine?.events.levelSwitched(1);
    expect(host.onQualityChange).toHaveBeenLastCalledWith({
      selection: { height: 720 },
      active: { width: 1280, height: 720, bitrate: 3_000_000 },
    });
  });

  it("a host overlay pauses playback and disables shortcuts", async () => {
    await start();
    controller.setBlocked(true);
    expect(media.pause).toHaveBeenCalled();
    expect(controller.handleKey({ key: " " })).toBe(false);
    await controller.play("pointer");
    expect(media.play).toHaveBeenCalledTimes(1);
  });
});
