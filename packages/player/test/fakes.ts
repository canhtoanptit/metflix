/**
 * Test doubles for the controller: a scriptable media element (jsdom implements no playback)
 * and an engine factory that records what the controller asked for.
 */
import { type Mock, vi } from "vitest";
import type {
  EngineConfig,
  EngineEvents,
  EngineFactory,
  PlaybackEngine,
} from "../src/engine/types.ts";

export interface FakeMedia extends HTMLVideoElement {
  emit(type: string): void;
  setTime(seconds: number): void;
  /** Move the playhead without an event (playback between two `timeupdate`s). */
  advance(seconds: number): void;
  blockAutoplay: boolean;
}

export function createFakeMedia(duration = 150): FakeMedia {
  const media = document.createElement("video") as FakeMedia;
  let paused = true;
  let time = 0;
  let volume = 1;
  let muted = false;
  let rate = 1;
  media.blockAutoplay = false;
  const fire = (type: string) => media.dispatchEvent(new Event(type));
  Object.defineProperties(media, {
    paused: { get: () => paused },
    ended: { get: () => false },
    duration: { get: () => duration },
    currentTime: {
      get: () => time,
      set: (value: number) => {
        time = value;
        fire("seeking");
        fire("seeked");
      },
    },
    volume: {
      get: () => volume,
      set: (value: number) => {
        volume = value;
        fire("volumechange");
      },
    },
    muted: {
      get: () => muted,
      set: (value: boolean) => {
        muted = value;
        fire("volumechange");
      },
    },
    playbackRate: {
      get: () => rate,
      set: (value: number) => {
        rate = value;
        fire("ratechange");
      },
    },
    buffered: { get: () => ({ length: 0, start: () => 0, end: () => 0 }) },
  });
  media.play = vi.fn(async () => {
    if (media.blockAutoplay && !muted) {
      throw new DOMException("gesture required", "NotAllowedError");
    }
    paused = false;
    fire("play");
    fire("playing");
  });
  media.pause = vi.fn(() => {
    if (paused) return;
    paused = true;
    fire("pause");
  });
  media.load = vi.fn();
  media.emit = fire;
  media.setTime = (seconds: number) => {
    time = seconds;
    fire("timeupdate");
  };
  media.advance = (seconds: number) => {
    time += seconds;
  };
  return media;
}

export interface FakeEngine extends PlaybackEngine {
  config: EngineConfig;
  events: EngineEvents;
  destroyed: boolean;
  setQuality: Mock<(mode: "auto" | number) => void>;
  setAudioTrack: Mock<(id: number) => void>;
}

export function createFakeEngineFactory() {
  const engines: FakeEngine[] = [];
  const factory: EngineFactory = async (kind, _media, config, events) => {
    const engine: FakeEngine = {
      kind,
      config,
      events,
      destroyed: false,
      setQuality: vi.fn<(mode: "auto" | number) => void>(),
      setAudioTrack: vi.fn<(id: number) => void>(),
      destroy() {
        engine.destroyed = true;
      },
    };
    engines.push(engine);
    return engine;
  };
  return { factory, engines };
}

/** Let queued microtasks (engine creation, play promises) settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
