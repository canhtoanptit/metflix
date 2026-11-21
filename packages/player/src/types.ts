/**
 * Public types of `<Player>`. A `PlaybackSession` from `POST /playback/sessions` is assignable
 * to `PlayerSession` as-is.
 */
import type {
  Episode,
  NextEpisode,
  PlaybackSession,
  PlaybackState,
  SeasonSummary,
} from "@webflix/contracts";
import type { HlsConfig } from "hls.js";
import type { CSSProperties, ReactNode, Ref } from "react";
import type { EnginePreference } from "./core/engine-choice.ts";
import type { PlayerError } from "./core/errors.ts";
import type { PlayerLabels } from "./core/labels.ts";
import type { PlayerPreferences, PreferenceStorage } from "./core/preferences.ts";
import type { PlaybackPhase } from "./core/state.ts";

/** The parts of a `PlaybackSession` the player reads. */
export type PlayerSession = Pick<
  PlaybackSession,
  | "id"
  | "manifestUrl"
  | "durationSec"
  | "resumePositionSec"
  | "textTracks"
  | "trickPlay"
  | "markers"
  | "nextEpisode"
  | "maxVideoHeight"
  | "autoplayNextEpisode"
  | "display"
> &
  Partial<Pick<PlaybackSession, "heartbeatIntervalSec" | "bestVideoQuality">>;

export type ProgressReason = "interval" | "pause" | "seek" | "ended" | "hidden" | "unload";

/**
 * A progress sample. `positionSec`, `durationSec` and `state` are exactly `HeartbeatBody`;
 * `sessionId` says which session it belongs to (reports can trail a source swap).
 */
export interface ProgressReport {
  sessionId: string;
  positionSec: number;
  durationSec: number;
  state: PlaybackState;
  reason: ProgressReason;
}

export type NextEpisodeReason = "autoplay" | "user";

export interface QualityChange {
  /** What the viewer chose: Auto, or a fixed height. */
  selection: "auto" | { height: number };
  /** What is playing now (null until the first fragment). */
  active: { width: number; height: number; bitrate: number } | null;
}

/** An episode row in the episodes panel; the contract's `Episode` is assignable. */
export type EpisodeSummary = Pick<
  Episode,
  | "id"
  | "seasonNumber"
  | "number"
  | "name"
  | "synopsis"
  | "runtimeSec"
  | "still"
  | "isPlayable"
  | "progress"
>;

/** Feeds the episodes panel lazily. Seasons are listed up front; episodes load on demand. */
export interface EpisodesSource {
  seasons: readonly Pick<SeasonSummary, "number" | "name" | "episodeCount">[];
  /** Highlighted as "Now playing". Defaults to `session.episodeId` / the display episode. */
  currentEpisodeId?: string | null;
  /** Season shown when the panel opens. Defaults to the playing episode's season. */
  initialSeasonNumber?: number;
  /**
   * Load one season's episodes (`GET /titles/:id/seasons/:n/episodes`). Called at most once per
   * season while the source object is unchanged; abort the request when `signal` fires.
   */
  loadEpisodes(seasonNumber: number, signal: AbortSignal): Promise<readonly EpisodeSummary[]>;
}

export interface EndScreenContext {
  /** `credits`: the picture shrank at the credits marker; `ended`: playback finished. */
  phase: "credits" | "ended";
  /** Return to full-size credits (only meaningful in `credits`). */
  watchCredits(): void;
  replay(): void;
  back(): void;
}

export interface PlayerProps {
  /** What to play. A new `session.id` (or `manifestUrl`) loads the new source in place. */
  session: PlayerSession;
  /** Start here instead of `session.resumePositionSec` (e.g. after recreating a session). */
  startPositionSec?: number;
  /** Start playing as soon as possible. Default true. */
  autoPlay?: boolean;
  /**
   * Overrides `session.autoplayNextEpisode` (the profile setting), e.g. to stop after several
   * unattended episodes.
   */
  autoplayNextEpisode?: boolean;
  /** Seconds of the next-episode countdown. Default 10. */
  nextEpisodeCountdownSec?: number;
  /** Synopsis for the paused-state overlay (the session carries none). */
  synopsis?: string | null;

  /** Feeds the episodes panel; omit for movies (the Episodes button is hidden). */
  episodes?: EpisodesSource | null;
  /**
   * End screen for the last episode or a movie (e.g. "More like this"): rendered beside the
   * shrunken picture from the credits marker, and after the end.
   */
  renderEndScreen?: (context: EndScreenContext) => ReactNode;
  /**
   * Host overlay that blocks playback (e.g. "Playback stopped: this account is playing on too
   * many screens"). While set, playback pauses, controls and shortcuts are disabled and focus
   * is held inside the overlay.
   */
  blockingOverlay?: ReactNode;

  /** Cadence of `onProgress` reports. Default `session.heartbeatIntervalSec`, else 30. */
  progressIntervalSec?: number;
  /** Periodic and event-driven progress samples; turn them into heartbeats. */
  onProgress?: (report: ProgressReport) => void;
  onStateChange?: (phase: PlaybackPhase) => void;
  /** Playback reached the end of the source. */
  onEnded?: () => void;
  /** Go to `session.nextEpisode` (countdown finished, or the viewer chose it). */
  onNextEpisode?: (next: NextEpisode, reason: NextEpisodeReason) => void;
  /** The viewer picked an episode in the episodes panel. */
  onSelectEpisode?: (episode: EpisodeSummary) => void;
  /** The back arrow (top left). Hidden when omitted. */
  onBack?: () => void;
  onQualityChange?: (change: QualityChange) => void;
  /**
   * Fatal playback errors (recoverable ones are handled inside). For `forbidden` (expired
   * media token) create a new session and pass it with `startPositionSec: error.positionSec`.
   */
  onError?: (error: PlayerError) => void;
  onFullscreenChange?: (fullscreen: boolean) => void;

  /** Host preferences that win over remembered ones (e.g. the profile's subtitle language). */
  preferences?: Partial<PlayerPreferences>;
  /** Called with the full preferences whenever the viewer changes one. */
  onPreferencesChange?: (
    preferences: PlayerPreferences,
    changed: readonly (keyof PlayerPreferences)[],
  ) => void;
  /**
   * Where preferences persist: a storage key for localStorage (default
   * `"webflix.player.preferences.v1"`; use one per profile), a custom storage, or `false`.
   */
  preferenceStorage?: string | PreferenceStorage | false;

  /** Copy overrides (localisation). */
  labels?: Partial<PlayerLabels>;
  /** `auto` (default): hls.js where MSE exists, native HLS otherwise. */
  engine?: EnginePreference;
  /** Merged over the player's hls.js configuration. */
  hlsConfig?: Partial<HlsConfig>;
  /** `crossorigin` on the media element, for cross-origin sources and subtitles. */
  crossOrigin?: "anonymous" | "use-credentials";
  /**
   * Keyboard shortcuts while focus is anywhere on the page (`document`), not only inside the
   * player. Default true: the watch page is the player. Editable fields are always ignored.
   */
  globalShortcuts?: boolean;
  /** Focus the player on mount so shortcuts work immediately. Default true. */
  autoFocus?: boolean;

  className?: string;
  style?: CSSProperties;
  ref?: Ref<PlayerHandle>;
}

/** Imperative handle (`ref`) for what a host legitimately needs to drive. */
export interface PlayerHandle {
  play(): Promise<void>;
  pause(): void;
  seek(positionSec: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPhase(): PlaybackPhase;
  /** A progress sample right now (e.g. for a final `keepalive` heartbeat on navigation). */
  getProgress(reason?: ProgressReason): ProgressReport | null;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  enterFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;
  /** Reload the current source at the current position (after a fatal error). */
  retry(): void;
  showControls(): void;
  focus(): void;
  /** The underlying element, for analytics or integrations. Do not change its source. */
  readonly media: HTMLVideoElement | null;
}
