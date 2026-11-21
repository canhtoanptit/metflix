/**
 * The player state machine: one serialisable state object and a pure reducer. Media element and
 * engine events come in as actions (dispatched by the controller); the React view only reads.
 *
 * Phase transitions (media-driven):
 *
 *   idle ──load──▶ loading ──playing──▶ playing ◀──playing── buffering
 *                     │                  │  ▲                    ▲
 *                     │               pause│ │play               │ waiting
 *                     ▼                  ▼  │                    │
 *                   paused ◀─────────── paused        playing ───┘
 *   any ──ended──▶ ended ──play──▶ loading/playing      any ──fatal error──▶ error
 */
import type { PlaybackMarkers, PlaybackState, TextTrack, TrickPlay } from "@webflix/contracts";
import type { CueNode } from "./cue-text.ts";
import type { EngineKind } from "./engine-choice.ts";
import type { PlayerError } from "./errors.ts";
import {
  INITIAL_MOMENTS,
  type MomentsContext,
  type MomentsState,
  type MomentsView,
  tickCountdown,
  updateMoments,
  viewMoments,
} from "./moments.ts";
import { clampVolume, DEFAULT_PREFERENCES, type PlayerPreferences } from "./preferences.ts";
import type { QualityLevel } from "./tracks.ts";

export type PlaybackPhase =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "buffering"
  | "ended"
  | "error";

export type MenuId = "audio-subtitles" | "speed" | "quality";
export type PanelId = "episodes";

export interface BufferedRange {
  start: number;
  end: number;
}

export interface AudioTrackOption {
  id: number;
  language: string;
  /** Name from the manifest (may be empty). */
  name: string;
}

export interface RenderedCue {
  id: string;
  nodes: CueNode[];
  /** VTTCue `line`: a number places the cue explicitly (e.g. 0 = top), "auto" = bottom. */
  line: number | "auto";
  snapToLines: boolean;
  align: "start" | "center" | "end" | "left" | "right";
}

export type Feedback =
  | { kind: "play" | "pause"; nonce: number }
  | { kind: "seek"; direction: -1 | 1; amountSec: number; nonce: number }
  | { kind: "volume"; level: number; muted: boolean; nonce: number }
  | { kind: "toast"; text: string; nonce: number };

/** What the player knows about the loaded source (from the session). */
export interface SourceInfo {
  /** Identity: a new key means a new load (new session or new episode). */
  key: string;
  durationHint: number;
  markers: PlaybackMarkers;
  textTracks: readonly TextTrack[];
  trickPlay: TrickPlay | null;
  hasNextEpisode: boolean;
  autoplayNext: boolean;
  countdownSec: number;
  maxVideoHeight: number;
}

export interface PlayerState {
  source: SourceInfo | null;
  engine: EngineKind | null;
  phase: PlaybackPhase;
  /** Someone (viewer, autoplay or host) wants playback running. */
  playIntent: boolean;
  /** The browser refused autoplay; a big Play button is shown. */
  autoplayBlocked: boolean;
  /** A frame has been presented for this source (gates the fade-in and the advisory). */
  firstFrame: boolean;
  currentTime: number;
  duration: number;
  buffered: readonly BufferedRange[];
  seeking: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
  qualityLevels: readonly QualityLevel[];
  /** False on the native path: the browser picks renditions itself. */
  qualityControllable: boolean;
  qualityMode: "auto" | number;
  activeQualityId: number | null;
  audioTracks: readonly AudioTrackOption[];
  activeAudioTrackId: number | null;
  textTrackId: string | null;
  cues: readonly RenderedCue[];
  error: PlayerError | null;
  fullscreen: boolean;
  pip: boolean;
  controlsVisible: boolean;
  pausedIdle: boolean;
  menu: MenuId | null;
  panel: PanelId | null;
  scrubbing: boolean;
  feedback: Feedback | null;
  announcement: { text: string; nonce: number } | null;
  advisoryVisible: boolean;
  /** The host shows a blocking overlay (e.g. the session ended elsewhere). */
  blocked: boolean;
  moments: MomentsState;
  preferences: PlayerPreferences;
}

export function createInitialState(
  preferences: PlayerPreferences = DEFAULT_PREFERENCES,
): PlayerState {
  return {
    source: null,
    engine: null,
    phase: "idle",
    playIntent: false,
    autoplayBlocked: false,
    firstFrame: false,
    currentTime: 0,
    duration: 0,
    buffered: [],
    seeking: false,
    playbackRate: preferences.playbackRate,
    volume: preferences.volume,
    muted: preferences.muted,
    qualityLevels: [],
    qualityControllable: false,
    qualityMode: "auto",
    activeQualityId: null,
    audioTracks: [],
    activeAudioTrackId: null,
    textTrackId: null,
    cues: [],
    error: null,
    fullscreen: false,
    pip: false,
    controlsVisible: true,
    pausedIdle: false,
    menu: null,
    panel: null,
    scrubbing: false,
    feedback: null,
    announcement: null,
    advisoryVisible: false,
    blocked: false,
    moments: INITIAL_MOMENTS,
    preferences,
  };
}

export type PlayerAction =
  | { type: "source/load"; source: SourceInfo; startPositionSec: number; autoplay: boolean }
  | { type: "source/update"; source: SourceInfo }
  | { type: "source/unload" }
  | { type: "engine/ready"; engine: EngineKind }
  | { type: "engine/levels"; levels: readonly QualityLevel[]; controllable: boolean }
  | { type: "engine/level-switched"; id: number | null }
  | { type: "engine/quality-mode"; mode: "auto" | number }
  | { type: "engine/audio-tracks"; tracks: readonly AudioTrackOption[]; activeId: number | null }
  | { type: "engine/audio-switched"; id: number }
  | { type: "engine/error"; error: PlayerError }
  | { type: "media/duration"; duration: number }
  | { type: "media/time"; currentTime: number }
  | { type: "media/buffered"; ranges: readonly BufferedRange[] }
  | { type: "media/play" }
  | { type: "media/playing" }
  | { type: "media/pause" }
  | { type: "media/waiting" }
  | { type: "media/seeking"; target: number }
  | { type: "media/seeked" }
  | { type: "media/ended" }
  | { type: "media/rate"; rate: number }
  | { type: "media/volume"; volume: number; muted: boolean }
  | { type: "media/first-frame" }
  | { type: "media/autoplay-blocked" }
  | { type: "text/select"; id: string | null }
  | { type: "text/cues"; cues: readonly RenderedCue[] }
  | { type: "display/fullscreen"; value: boolean }
  | { type: "display/pip"; value: boolean }
  | { type: "ui/idle"; controlsVisible: boolean; pausedIdle: boolean }
  | { type: "ui/menu"; menu: MenuId | null }
  | { type: "ui/panel"; panel: PanelId | null }
  | { type: "ui/scrubbing"; value: boolean }
  | { type: "ui/feedback"; feedback: Feedback | null }
  | { type: "ui/announce"; text: string }
  | { type: "ui/advisory"; visible: boolean }
  | { type: "ui/blocked"; value: boolean }
  | { type: "moments/tick"; elapsedMs: number }
  | { type: "moments/dismiss-credits" }
  | { type: "moments/next-requested" }
  | { type: "preferences/set"; preferences: PlayerPreferences };

let nonce = 0;
/** Monotonic id for transient UI (feedback, announcements) so equal content still re-fires. */
export function nextNonce(): number {
  nonce += 1;
  return nonce;
}

function momentsContext(
  state: PlayerState,
  overrides: Partial<MomentsContext> = {},
): MomentsContext | null {
  const source = state.source;
  if (!source) return null;
  return {
    positionSec: state.currentTime,
    durationSec: state.duration || source.durationHint,
    ended: state.phase === "ended",
    markers: source.markers,
    hasNextEpisode: source.hasNextEpisode,
    autoplayNext: source.autoplayNext,
    countdownSec: source.countdownSec,
    ...overrides,
  };
}

function withMoments(state: PlayerState): PlayerState {
  const ctx = momentsContext(state);
  if (!ctx) return state;
  const moments = updateMoments(state.moments, ctx);
  return moments === state.moments ? state : { ...state, moments };
}

const sameRanges = (a: readonly BufferedRange[], b: readonly BufferedRange[]) =>
  a.length === b.length &&
  a.every((range, i) => range.start === b[i]?.start && range.end === b[i]?.end);

export function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case "source/load":
      return {
        ...state,
        source: action.source,
        engine: null,
        phase: "loading",
        playIntent: action.autoplay,
        autoplayBlocked: false,
        firstFrame: false,
        currentTime: action.startPositionSec,
        duration: action.source.durationHint,
        buffered: [],
        seeking: false,
        qualityLevels: [],
        qualityControllable: false,
        qualityMode: "auto",
        activeQualityId: null,
        audioTracks: [],
        activeAudioTrackId: null,
        textTrackId: null,
        cues: [],
        error: null,
        menu: null,
        panel: state.panel,
        scrubbing: false,
        feedback: null,
        advisoryVisible: false,
        moments: INITIAL_MOMENTS,
      };
    case "source/update":
      return state.source?.key === action.source.key
        ? withMoments({ ...state, source: action.source })
        : state;
    case "source/unload":
      return {
        ...createInitialState(state.preferences),
        fullscreen: state.fullscreen,
        blocked: state.blocked,
      };
    case "engine/ready":
      return { ...state, engine: action.engine };
    case "engine/levels":
      return { ...state, qualityLevels: action.levels, qualityControllable: action.controllable };
    case "engine/level-switched":
      return state.activeQualityId === action.id ? state : { ...state, activeQualityId: action.id };
    case "engine/quality-mode":
      return { ...state, qualityMode: action.mode };
    case "engine/audio-tracks":
      return { ...state, audioTracks: action.tracks, activeAudioTrackId: action.activeId };
    case "engine/audio-switched":
      return { ...state, activeAudioTrackId: action.id };
    case "engine/error":
      return {
        ...state,
        phase: "error",
        error: action.error,
        playIntent: false,
        seeking: false,
        menu: null,
        autoplayBlocked: false,
      };
    case "media/duration":
      if (!Number.isFinite(action.duration) || action.duration <= 0) return state;
      return withMoments({ ...state, duration: action.duration });
    case "media/time": {
      if (state.phase === "error") return state;
      const next =
        state.currentTime === action.currentTime
          ? state
          : { ...state, currentTime: action.currentTime };
      return withMoments(next);
    }
    case "media/buffered":
      return sameRanges(state.buffered, action.ranges)
        ? state
        : { ...state, buffered: action.ranges };
    case "media/play":
      if (state.phase === "error") return state;
      return {
        ...state,
        playIntent: true,
        autoplayBlocked: false,
        // Replay from the end, or a play before data arrives: loading until `playing`.
        phase: state.phase === "ended" || state.phase === "idle" ? "loading" : state.phase,
      };
    case "media/playing":
      if (state.phase === "error") return state;
      return withMoments({ ...state, phase: "playing", playIntent: true, autoplayBlocked: false });
    case "media/pause":
      if (state.phase === "error" || state.phase === "ended")
        return { ...state, playIntent: false };
      return {
        ...state,
        phase: state.phase === "loading" ? "loading" : "paused",
        playIntent: false,
      };
    case "media/waiting":
      if (state.phase === "playing") return { ...state, phase: "buffering" };
      return state;
    case "media/seeking":
      return withMoments({
        ...state,
        seeking: true,
        currentTime: action.target,
        // Seeking away from the end leaves the ended state.
        phase: state.phase === "ended" ? (state.playIntent ? "buffering" : "paused") : state.phase,
      });
    case "media/seeked":
      return { ...state, seeking: false };
    case "media/ended":
      return withMoments({
        ...state,
        phase: "ended",
        seeking: false,
        currentTime: state.duration || state.currentTime,
      });
    case "media/rate":
      return state.playbackRate === action.rate
        ? state
        : {
            ...state,
            playbackRate: action.rate,
            preferences: { ...state.preferences, playbackRate: action.rate },
          };
    case "media/volume": {
      const volume = clampVolume(action.volume);
      if (state.volume === volume && state.muted === action.muted) return state;
      return {
        ...state,
        volume,
        muted: action.muted,
        preferences: { ...state.preferences, volume, muted: action.muted },
      };
    }
    case "media/first-frame":
      if (state.firstFrame) return state;
      return {
        ...state,
        firstFrame: true,
        // Data is in and nobody asked to play: settle into paused (spinner off).
        phase: state.phase === "loading" && !state.playIntent ? "paused" : state.phase,
      };
    case "media/autoplay-blocked":
      return {
        ...state,
        autoplayBlocked: true,
        playIntent: false,
        phase: state.phase === "loading" ? "paused" : state.phase,
      };
    case "text/select":
      return state.textTrackId === action.id
        ? state
        : { ...state, textTrackId: action.id, cues: [] };
    case "text/cues":
      return { ...state, cues: action.cues };
    case "display/fullscreen":
      return state.fullscreen === action.value ? state : { ...state, fullscreen: action.value };
    case "display/pip":
      return state.pip === action.value ? state : { ...state, pip: action.value };
    case "ui/idle":
      if (
        state.controlsVisible === action.controlsVisible &&
        state.pausedIdle === action.pausedIdle
      ) {
        return state;
      }
      return {
        ...state,
        controlsVisible: action.controlsVisible,
        pausedIdle: action.pausedIdle,
        // Menus never outlive the controls they hang from.
        menu: action.controlsVisible ? state.menu : null,
      };
    case "ui/menu":
      return state.menu === action.menu ? state : { ...state, menu: action.menu };
    case "ui/panel":
      return state.panel === action.panel ? state : { ...state, panel: action.panel, menu: null };
    case "ui/scrubbing":
      return state.scrubbing === action.value ? state : { ...state, scrubbing: action.value };
    case "ui/feedback":
      return { ...state, feedback: action.feedback };
    case "ui/announce":
      return { ...state, announcement: { text: action.text, nonce: nextNonce() } };
    case "ui/advisory":
      return state.advisoryVisible === action.visible
        ? state
        : { ...state, advisoryVisible: action.visible };
    case "ui/blocked":
      return state.blocked === action.value
        ? state
        : { ...state, blocked: action.value, menu: null, panel: action.value ? null : state.panel };
    case "moments/tick": {
      const moments = tickCountdown(state.moments, action.elapsedMs);
      return moments === state.moments ? state : { ...state, moments };
    }
    case "moments/dismiss-credits":
      return {
        ...state,
        moments: { ...state.moments, creditsDismissed: true, countdownMs: null },
      };
    case "moments/next-requested":
      return { ...state, moments: { ...state.moments, nextRequested: true, countdownMs: null } };
    case "preferences/set":
      return { ...state, preferences: action.preferences };
    default:
      return state;
  }
}

/** Heartbeat state for `HeartbeatBody.state` (blueprint §6). */
export function heartbeatState(state: PlayerState): PlaybackState {
  switch (state.phase) {
    case "playing":
      return "playing";
    case "buffering":
      return "buffering";
    case "loading":
      return state.playIntent ? "buffering" : "paused";
    case "ended":
      return "ended";
    default:
      return "paused";
  }
}

/** The buffering spinner: stalled while playback is wanted, or a slow seek. */
export function isBuffering(state: PlayerState): boolean {
  if (state.phase === "buffering") return true;
  if (state.phase === "loading") return state.playIntent || !state.firstFrame;
  return state.seeking && state.phase !== "error";
}

/** End of the buffered range that contains `time` (0 when not buffered there). */
export function bufferedEndAt(ranges: readonly BufferedRange[], time: number): number {
  for (const range of ranges) {
    if (time >= range.start - 0.5 && time <= range.end) return range.end;
  }
  return 0;
}

/** True while the countdown should run: playing (or at the end) and nothing interrupts. */
export function countdownRunning(state: PlayerState): boolean {
  if (state.moments.countdownMs === null || state.moments.countdownMs === 0) return false;
  if (state.blocked || state.panel !== null || state.scrubbing) return false;
  return state.phase === "playing" || state.phase === "ended";
}

/** Skip button, next-episode card and end screen for the current state (null: no source). */
export function selectMomentsView(state: PlayerState): MomentsView | null {
  if (state.phase === "error") return null;
  const ctx = momentsContext(state);
  return ctx ? viewMoments(state.moments, ctx) : null;
}
