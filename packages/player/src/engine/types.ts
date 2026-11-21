import type { HlsConfig } from "hls.js";
import type { EngineKind } from "../core/engine-choice.ts";
import type { PlayerError } from "../core/errors.ts";
import type { AudioTrackOption } from "../core/state.ts";
import type { QualityLevel } from "../core/tracks.ts";

export interface EngineConfig {
  url: string;
  startPositionSec: number;
  /** Plan cap: renditions taller than this are removed before anything loads. */
  maxVideoHeight: number;
  preferredAudioLanguage: string | null;
  /** Escape hatch merged over the player's hls.js defaults. */
  hlsConfig?: Partial<HlsConfig> | undefined;
}

/** Engine → player notifications. Errors arrive only once recovery has given up. */
export interface EngineEvents {
  levels(levels: readonly QualityLevel[], controllable: boolean): void;
  levelSwitched(id: number | null): void;
  audioTracks(tracks: readonly AudioTrackOption[], activeId: number | null): void;
  audioSwitched(id: number): void;
  fatal(error: Omit<PlayerError, "positionSec" | "fatal">): void;
}

/**
 * One loaded source on one media element. The controller owns the element and its listeners;
 * an engine only feeds it (hls.js MSE, native HLS, or a progressive file) and must release
 * everything it created in `destroy()`.
 */
export interface PlaybackEngine {
  readonly kind: EngineKind;
  /** `"auto"` or a level id from `levels()`. No-op when not controllable. */
  setQuality(mode: "auto" | number): void;
  setAudioTrack(id: number): void;
  destroy(): void;
}

export type EngineFactory = (
  kind: EngineKind,
  media: HTMLVideoElement,
  config: EngineConfig,
  events: EngineEvents,
) => Promise<PlaybackEngine>;
