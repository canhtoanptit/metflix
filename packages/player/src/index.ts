/**
 * @webflix/player: the video player component library.
 *
 * - `<Player>` plays a `PlaybackSession` (hls.js, native HLS fallback) with the full Webflix
 *   watch experience and reports progress/events to the host. It never calls the API.
 * - `<PreviewPlayer>` is the muted, chrome-less clip player for the billboard and hover cards.
 *
 * Styles ship with the components (plain CSS, themed with `--wfp-*` custom properties); see
 * README for the integration guide.
 */

export { trickPlayTile } from "@webflix/contracts";
export type { EnginePreference } from "./core/engine-choice.ts";
export type { PlayerError, PlayerErrorCode } from "./core/errors.ts";
export {
  formatPlaybackTime,
  formatRemainingTime,
  formatRuntime,
  formatSpokenDuration,
} from "./core/format.ts";
export { type PlayerCommand, resolveKeyCommand } from "./core/keymap.ts";
export { DEFAULT_LABELS, type PlayerLabels } from "./core/labels.ts";
export {
  createLocalPreferenceStorage,
  createMemoryPreferenceStorage,
  DEFAULT_PREFERENCES,
  DEFAULT_PREFERENCES_KEY,
  PLAYBACK_RATES,
  type PlayerPreferences,
  type PreferenceStorage,
} from "./core/preferences.ts";
export type { PlaybackPhase } from "./core/state.ts";
export { qualityBadge, sessionQualityLabel } from "./core/tracks.ts";
export { Player } from "./react/Player.tsx";
export {
  PreviewPlayer,
  type PreviewPlayerHandle,
  type PreviewPlayerProps,
} from "./react/PreviewPlayer.tsx";
export type {
  EndScreenContext,
  EpisodeSummary,
  EpisodesSource,
  NextEpisodeReason,
  PlayerHandle,
  PlayerProps,
  PlayerSession,
  ProgressReason,
  ProgressReport,
  QualityChange,
} from "./types.ts";
