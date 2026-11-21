// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MAX_STALL_NUDGES } from "../src/core/errors.ts";
import { createHlsEngine } from "../src/engine/hls-engine.ts";
import type { EngineEvents } from "../src/engine/types.ts";
import { createFakeMedia } from "./fakes.ts";

/** Just enough of hls.js for the engine: events in, the calls it makes recorded. */
const fake = vi.hoisted(() => {
  const Events = {
    MANIFEST_PARSED: "hlsManifestParsed",
    LEVELS_UPDATED: "hlsLevelsUpdated",
    LEVEL_SWITCHED: "hlsLevelSwitched",
    AUDIO_TRACKS_UPDATED: "hlsAudioTracksUpdated",
    AUDIO_TRACK_SWITCHED: "hlsAudioTrackSwitched",
    FRAG_BUFFERED: "hlsFragBuffered",
    ERROR: "hlsError",
  };
  const instances: FakeHls[] = [];
  class FakeHls {
    static Events = Events;
    static isSupported = () => true;
    levels: unknown[] = [];
    audioTracks: unknown[] = [];
    audioTrack = -1;
    nextLevel = -1;
    listeners = new Map<string, Array<(event: string, data: unknown) => void>>();
    recoverMediaError = vi.fn();
    swapAudioCodec = vi.fn();
    startLoad = vi.fn();
    stopLoad = vi.fn();
    constructor() {
      instances.push(this);
    }
    on(event: string, listener: (event: string, data: unknown) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    emit(event: string, data: unknown) {
      for (const listener of this.listeners.get(event) ?? []) listener(event, data);
    }
    attachMedia() {}
    loadSource() {}
    removeLevel() {}
    destroy() {}
  }
  return { FakeHls, instances, Events };
});

vi.mock("hls.js", () => ({ default: fake.FakeHls }));

const events: EngineEvents = {
  levels: vi.fn(),
  levelSwitched: vi.fn(),
  audioTracks: vi.fn(),
  audioSwitched: vi.fn(),
  fatal: vi.fn(),
};

/** What hls.js reports when the playhead is stuck with the rest of the title buffered ahead. */
const stuck = { type: "mediaError", details: "bufferStalledError", fatal: false, buffer: 149.9 };

describe("hls.js engine: a playhead stuck with data buffered ahead", () => {
  it("is nudged forward, then the media is recovered; real progress resets the budget", async () => {
    const media = createFakeMedia();
    const engine = await createHlsEngine(
      media,
      {
        url: "/media/t/vod/a/master.m3u8",
        startPositionSec: 0,
        maxVideoHeight: 1080,
        preferredAudioLanguage: null,
      },
      events,
    );
    const hls = fake.instances.at(-1);
    if (!hls) throw new Error("no hls instance");
    media.setTime(0.183);

    // Each report (hls.js re-reports after the seek a nudge makes) seeks a little further.
    hls.emit(fake.Events.ERROR, stuck);
    expect(media.currentTime).toBeCloseTo(0.283);
    for (let nudge = 2; nudge <= MAX_STALL_NUDGES; nudge += 1) {
      hls.emit(fake.Events.ERROR, stuck);
    }
    expect(media.currentTime).toBeCloseTo(0.183 + 0.1 + 0.2 + 0.3);
    expect(hls.recoverMediaError).not.toHaveBeenCalled();

    // Still stuck after every nudge: rebuild the media pipeline.
    hls.emit(fake.Events.ERROR, stuck);
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(1);

    // Playback moves on: a later stall starts the ladder again with a nudge.
    media.setTime(5);
    hls.emit(fake.Events.ERROR, stuck);
    expect(media.currentTime).toBeCloseTo(5.1);
    expect(events.fatal).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("leaves a starved playhead to hls.js", async () => {
    const media = createFakeMedia();
    await createHlsEngine(
      media,
      {
        url: "/media/t/vod/a/master.m3u8",
        startPositionSec: 0,
        maxVideoHeight: 1080,
        preferredAudioLanguage: null,
      },
      events,
    );
    const hls = fake.instances.at(-1);
    media.setTime(12);
    hls?.emit(fake.Events.ERROR, { ...stuck, buffer: 0 });
    expect(media.currentTime).toBe(12);
  });
});
