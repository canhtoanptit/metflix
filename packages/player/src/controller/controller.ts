/**
 * PlayerController: owns one media element, the engine feeding it, the store, the timers and
 * every listener. The React view renders from the store and calls commands; nothing here
 * depends on React, so the behaviour is testable with a fake engine and a jsdom element.
 *
 * Lifecycle: `attach(media, root)` → `load(request)` (any number of times: next episode,
 * retry) → `detach()` / `destroy()`. Detach releases everything (engine, `<track>`s, media
 * source, listeners, timers) and can be followed by another attach (React StrictMode).
 */
import type { ImageSet, TextTrack } from "@webflix/contracts";
import { imageUrl } from "@webflix/contracts";
import type { HlsConfig } from "hls.js";
import type { EnginePreference } from "../core/engine-choice.ts";
import { classifyMediaElementError, type PlayerError } from "../core/errors.ts";
import { formatPlaybackTime, formatRate } from "../core/format.ts";
import {
  createTapRecognizer,
  DEFAULT_TAP_CONFIG,
  type TapRecognizer,
  type TapZone,
} from "../core/gestures.ts";
import {
  type ActivityKind,
  createIdleTracker,
  DEFAULT_IDLE_CONFIG,
  type IdleConfig,
  type IdleTracker,
} from "../core/idle.ts";
import { type PlayerCommand, resolveKeyCommand, SEEK_STEP_SEC } from "../core/keymap.ts";
import { DEFAULT_LABELS, type PlayerLabels } from "../core/labels.ts";
import { activeSkipWindow, countdownFinished } from "../core/moments.ts";
import {
  changedPreferenceKeys,
  clampVolume,
  type PlayerPreferences,
  type PreferenceStorage,
  resolvePreferences,
  stepRate,
} from "../core/preferences.ts";
import {
  type BufferedRange,
  countdownRunning,
  createInitialState,
  type Feedback,
  heartbeatState,
  type MenuId,
  nextNonce,
  type PanelId,
  type PlaybackPhase,
  type PlayerAction,
  type PlayerState,
  playerReducer,
  type SourceInfo,
} from "../core/state.ts";
import { createStore, type Store } from "../core/store.ts";
import { languageLabel, menuTextTracks, qualityLabel, selectTextTrack } from "../core/tracks.ts";
import { defaultEngineFactory, resolveEngineKind } from "../engine/create-engine.ts";
import type { EngineEvents, EngineFactory, PlaybackEngine } from "../engine/types.ts";
import type { NextEpisodeReason, ProgressReason, ProgressReport, QualityChange } from "../types.ts";
import {
  enterFullscreen,
  exitFullscreen,
  isFullscreen,
  isPictureInPicture,
  togglePictureInPicture,
} from "./display.ts";
import { SidecarTextTracks } from "./text-tracks.ts";

export type CommandOrigin = "pointer" | "keyboard" | "touch" | "host";

export interface LoadRequest {
  /** Source identity; a different key is a different load. */
  key: string;
  sessionId: string;
  url: string;
  source: SourceInfo;
  startPositionSec: number;
  autoplay: boolean;
  enginePreference: EnginePreference;
  hlsConfig?: Partial<HlsConfig> | undefined;
  mediaSession?: { title: string; artist: string; artwork: ImageSet | null } | undefined;
}

export interface ControllerHost {
  onProgress?(report: ProgressReport): void;
  onStateChange?(phase: PlaybackPhase): void;
  onEnded?(): void;
  onNextEpisode?(reason: NextEpisodeReason): void;
  onQualityChange?(change: QualityChange): void;
  onError?(error: PlayerError): void;
  onPreferencesChange?(
    preferences: PlayerPreferences,
    changed: readonly (keyof PlayerPreferences)[],
  ): void;
  onFullscreenChange?(fullscreen: boolean): void;
}

export interface ControllerOptions {
  engineFactory?: EngineFactory;
  resolveEngine?: typeof resolveEngineKind;
  storage?: PreferenceStorage | null;
  preferenceOverrides?: Partial<PlayerPreferences> | undefined;
  idle?: IdleConfig;
}

type Timer = ReturnType<typeof setTimeout>;

/** Event-driven progress reports (pause, seek…) are throttled to one per this window. */
const EVENT_REPORT_MIN_GAP_MS = 2000;
const ADVISORY_MS = 6500;
const COUNTDOWN_TICK_MS = 200;
const SEEK_REPORT_DELAY_MS = 1200;

export class PlayerController {
  readonly store: Store<PlayerState, PlayerAction>;
  host: ControllerHost = {};
  labels: PlayerLabels = DEFAULT_LABELS;

  private media: HTMLVideoElement | null = null;
  private root: HTMLElement | null = null;
  private attachment: AbortController | null = null;
  private engine: PlaybackEngine | null = null;
  private live = false;
  private loadToken = 0;
  private request: LoadRequest | null = null;
  private text: SidecarTextTracks | null = null;
  private readonly idle: IdleTracker;
  private readonly taps: TapRecognizer;
  private readonly engineFactory: EngineFactory;
  private readonly resolveEngine: typeof resolveEngineKind;
  private readonly storage: PreferenceStorage | null;
  private prev: PlayerState;
  private readonly unsubscribe: () => void;
  private progressIntervalSec = 30;
  private progressTimer: Timer | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private countdownLast = 0;
  private feedbackTimer: Timer | null = null;
  private advisoryTimer: Timer | null = null;
  private seekReportTimer: Timer | null = null;
  private lastEventReportAt = Number.NEGATIVE_INFINITY;
  private endedNotified = false;
  private advisoryShown = false;
  private lastSubtitleLanguage: string | null = null;
  private seekStreak: { direction: -1 | 1; amount: number; at: number } | null = null;
  private destroyed = false;

  constructor(options: ControllerOptions = {}) {
    this.engineFactory = options.engineFactory ?? defaultEngineFactory;
    this.resolveEngine = options.resolveEngine ?? resolveEngineKind;
    this.storage = options.storage ?? null;
    const preferences = resolvePreferences(this.storage?.load(), options.preferenceOverrides);
    this.store = createStore(playerReducer, createInitialState(preferences));
    this.prev = this.store.getState();
    if (typeof preferences.subtitleLanguage === "string") {
      this.lastSubtitleLanguage = preferences.subtitleLanguage;
    }
    const scheduler = {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: unknown) => clearTimeout(handle as Timer),
    };
    this.idle = createIdleTracker(options.idle ?? DEFAULT_IDLE_CONFIG, scheduler, (idle) =>
      this.dispatch({ type: "ui/idle", ...idle }),
    );
    this.taps = createTapRecognizer(DEFAULT_TAP_CONFIG, scheduler, {
      onSingleTap: () => this.idle.toggle(),
      onSeekTap: (direction, streak) => this.seekBy(direction * SEEK_STEP_SEC, "touch", streak),
    });
    this.unsubscribe = this.store.subscribe(() => this.onStoreChange());
  }

  get state(): PlayerState {
    return this.store.getState();
  }

  get mediaElement(): HTMLVideoElement | null {
    return this.media;
  }

  private dispatch(action: PlayerAction): void {
    if (!this.destroyed) this.store.dispatch(action);
  }

  // --- lifecycle --------------------------------------------------------------------------

  attach(media: HTMLVideoElement, root: HTMLElement): void {
    if (this.destroyed) return;
    if (this.media === media && this.root === root) return;
    this.detach();
    this.media = media;
    this.root = root;
    const abort = new AbortController();
    this.attachment = abort;
    this.bindMedia(media, root, abort.signal);
    this.text = new SidecarTextTracks(media, (cues) => this.dispatch({ type: "text/cues", cues }));
    this.applyPreferencesToMedia();
    if (this.request) void this.startLoad(this.request);
  }

  detach(): void {
    // Last word for the current session: the host can send a final (keepalive) heartbeat.
    if (this.media) this.report("unload", true);
    this.loadToken += 1;
    this.teardownSource();
    this.text?.destroy();
    this.text = null;
    this.attachment?.abort();
    this.attachment = null;
    this.media = null;
    this.root = null;
    this.stopProgressTimer();
    this.stopCountdown();
    this.clearTimer("feedbackTimer");
    this.clearTimer("advisoryTimer");
    this.clearTimer("seekReportTimer");
    this.clearMediaSession();
  }

  /** Final teardown. Sends a last `unload` progress report for the current session. */
  destroy(): void {
    if (this.destroyed) return;
    this.detach();
    this.idle.dispose();
    this.taps.dispose();
    this.unsubscribe();
    this.destroyed = true;
  }

  load(request: LoadRequest): void {
    const previous = this.request;
    if (previous && previous.key === request.key) {
      this.request = { ...request, startPositionSec: previous.startPositionSec };
      this.dispatch({ type: "source/update", source: request.source });
      this.setMediaSessionMetadata();
      return;
    }
    if (previous) this.report("unload", true);
    this.request = request;
    if (this.media) void this.startLoad(request);
  }

  /** Reload the current source at the current (or failure) position. */
  retry(): void {
    const request = this.request;
    if (!request || !this.media) return;
    const state = this.state;
    const position = state.error?.positionSec ?? state.currentTime;
    void this.startLoad({ ...request, startPositionSec: position, autoplay: true });
  }

  setProgressInterval(seconds: number): void {
    const next = Number.isFinite(seconds) && seconds > 0 ? seconds : 30;
    if (next === this.progressIntervalSec) return;
    this.progressIntervalSec = next;
    if (this.progressTimer !== null) this.startProgressTimer();
  }

  setBlocked(blocked: boolean): void {
    if (this.state.blocked === blocked) return;
    this.dispatch({ type: "ui/blocked", value: blocked });
    if (blocked) this.media?.pause();
  }

  /** Host preferences changed (e.g. profile settings arrived): apply the overriding fields. */
  applyPreferenceOverrides(overrides: Partial<PlayerPreferences>): void {
    const current = this.state.preferences;
    const next = resolvePreferences(current, overrides);
    if (changedPreferenceKeys(current, next).length === 0) return;
    this.dispatch({ type: "preferences/set", preferences: next });
    this.applyPreferencesToMedia();
    if (next.subtitleLanguage !== current.subtitleLanguage) this.selectInitialTextTrack();
  }

  private async startLoad(request: LoadRequest): Promise<void> {
    const media = this.media;
    if (!media) return;
    const token = ++this.loadToken;
    this.teardownSource();
    this.endedNotified = false;
    this.advisoryShown = false;
    this.seekStreak = null;
    this.clearTimer("advisoryTimer");
    this.dispatch({
      type: "source/load",
      source: request.source,
      startPositionSec: request.startPositionSec,
      autoplay: request.autoplay,
    });
    this.text?.setTracks(request.source.textTracks);
    this.selectInitialTextTrack();
    this.applyPreferencesToMedia();
    this.setMediaSessionMetadata();
    this.startProgressTimer();

    let kind: Awaited<ReturnType<typeof resolveEngineKind>>;
    try {
      kind = await this.resolveEngine(request.url, request.enginePreference, media);
    } catch {
      kind = null;
    }
    if (token !== this.loadToken) return;
    if (!kind) {
      this.fail({ code: "unsupported", detail: "no playback path", httpStatus: null });
      return;
    }
    this.dispatch({ type: "engine/ready", engine: kind });
    const events = this.engineEvents(token);
    let engine: PlaybackEngine;
    try {
      engine = await this.engineFactory(
        kind,
        media,
        {
          url: request.url,
          startPositionSec: request.startPositionSec,
          maxVideoHeight: request.source.maxVideoHeight,
          preferredAudioLanguage: this.state.preferences.audioLanguage ?? null,
          hlsConfig: request.hlsConfig,
        },
        events,
      );
    } catch (error) {
      if (token === this.loadToken) {
        this.fail({ code: "unknown", detail: errorName(error), httpStatus: null });
      }
      return;
    }
    if (token !== this.loadToken) {
      engine.destroy();
      return;
    }
    this.engine = engine;
    this.live = true;
    this.applyPreferencesToMedia();
    if (request.autoplay && !this.state.blocked) void this.play("host");
  }

  private engineEvents(token: number): EngineEvents {
    const current = () => token === this.loadToken;
    return {
      levels: (levels, controllable) => {
        if (current()) this.dispatch({ type: "engine/levels", levels, controllable });
      },
      levelSwitched: (id) => {
        if (current()) this.dispatch({ type: "engine/level-switched", id });
      },
      audioTracks: (tracks, activeId) => {
        if (current()) this.dispatch({ type: "engine/audio-tracks", tracks, activeId });
      },
      audioSwitched: (id) => {
        if (current()) this.dispatch({ type: "engine/audio-switched", id });
      },
      fatal: (error) => {
        if (current()) this.fail(error);
      },
    };
  }

  private fail(error: Omit<PlayerError, "positionSec" | "fatal">): void {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    this.dispatch({
      type: "engine/error",
      error: {
        ...error,
        detail: offline && error.code === "network" ? `${error.detail} (offline)` : error.detail,
        // The element's playhead, not the last `timeupdate` sample (up to ~250 ms behind):
        // recovery (a renewed media token, a retry) resumes exactly where playback stopped.
        positionSec: this.media && this.live ? this.media.currentTime : this.state.currentTime,
        fatal: true,
      },
    });
    this.media?.pause();
  }

  private teardownSource(): void {
    this.live = false;
    this.engine?.destroy();
    this.engine = null;
    this.text?.setTracks([]);
    const media = this.media;
    if (media) {
      media.pause();
      // Release the decoder and any MediaSource: without this a detached element keeps its
      // buffers (and on iOS a hardware decoder slot) alive.
      media.removeAttribute("src");
      try {
        media.load();
      } catch {
        // jsdom and some embedded browsers do not implement load().
      }
    }
  }

  private bindMedia(media: HTMLVideoElement, root: HTMLElement, signal: AbortSignal): void {
    const on = (target: EventTarget, type: string, listener: () => void) =>
      target.addEventListener(type, listener, { signal });
    const live = (listener: () => void) => () => {
      if (this.live) listener();
    };
    const doc = root.ownerDocument;

    on(
      media,
      "loadedmetadata",
      live(() => this.dispatch({ type: "media/duration", duration: media.duration })),
    );
    on(
      media,
      "durationchange",
      live(() => this.dispatch({ type: "media/duration", duration: media.duration })),
    );
    on(
      media,
      "timeupdate",
      live(() => {
        this.dispatch({ type: "media/time", currentTime: media.currentTime });
        this.syncBuffered();
      }),
    );
    on(
      media,
      "progress",
      live(() => this.syncBuffered()),
    );
    on(
      media,
      "loadeddata",
      live(() => this.dispatch({ type: "media/first-frame" })),
    );
    on(
      media,
      "play",
      live(() => this.dispatch({ type: "media/play" })),
    );
    on(
      media,
      "playing",
      live(() => this.dispatch({ type: "media/playing" })),
    );
    on(
      media,
      "pause",
      live(() => this.dispatch({ type: "media/pause" })),
    );
    on(
      media,
      "waiting",
      live(() => this.dispatch({ type: "media/waiting" })),
    );
    on(
      media,
      "seeking",
      live(() => this.dispatch({ type: "media/seeking", target: media.currentTime })),
    );
    on(
      media,
      "seeked",
      live(() => {
        this.dispatch({ type: "media/seeked" });
        this.dispatch({ type: "media/time", currentTime: media.currentTime });
        this.syncBuffered();
        this.scheduleSeekReport();
        this.updatePositionState();
      }),
    );
    on(
      media,
      "ended",
      live(() => this.dispatch({ type: "media/ended" })),
    );
    on(media, "ratechange", () => {
      this.dispatch({ type: "media/rate", rate: media.playbackRate });
      this.updatePositionState();
    });
    on(media, "volumechange", () =>
      this.dispatch({ type: "media/volume", volume: media.volume, muted: media.muted }),
    );
    on(
      media,
      "error",
      live(() => {
        // hls.js reports (and recovers) media errors itself.
        if (this.engine?.kind === "hls.js") return;
        const code = classifyMediaElementError(media.error?.code ?? 0);
        if (code)
          this.fail({
            code,
            detail: media.error?.message || `MediaError ${media.error?.code}`,
            httpStatus: null,
          });
      }),
    );
    const syncPip = () => this.dispatch({ type: "display/pip", value: isPictureInPicture(media) });
    on(media, "enterpictureinpicture", syncPip);
    on(media, "leavepictureinpicture", syncPip);
    on(media, "webkitpresentationmodechanged", syncPip);
    const syncFullscreen = () =>
      this.dispatch({ type: "display/fullscreen", value: isFullscreen(root, media) });
    on(doc, "fullscreenchange", syncFullscreen);
    on(doc, "webkitfullscreenchange", syncFullscreen);
    // iPhone system fullscreen: our captions are invisible there, let the system draw them.
    on(media, "webkitbeginfullscreen", () => {
      this.text?.setNativeRendering(true);
      syncFullscreen();
    });
    on(media, "webkitendfullscreen", () => {
      this.text?.setNativeRendering(false);
      syncFullscreen();
    });
    on(doc, "visibilitychange", () => {
      if (doc.visibilityState === "hidden") this.report("hidden", true);
    });
    const view = doc.defaultView;
    if (view) {
      on(view, "pagehide", () => this.report("unload", true));
      on(view, "online", () => {
        if (this.state.error?.code === "network") this.retry();
      });
    }
  }

  private syncBuffered(): void {
    const media = this.media;
    if (!media) return;
    const ranges: BufferedRange[] = [];
    const buffered = media.buffered;
    for (let i = 0; i < buffered.length; i++) {
      ranges.push({ start: buffered.start(i), end: buffered.end(i) });
    }
    this.dispatch({ type: "media/buffered", ranges });
  }

  private applyPreferencesToMedia(): void {
    const media = this.media;
    if (!media) return;
    const { volume, muted, playbackRate } = this.state.preferences;
    try {
      if (media.volume !== volume) media.volume = volume;
    } catch {
      // iOS: volume is read-only (hardware buttons).
    }
    if (media.muted !== muted) media.muted = muted;
    media.defaultPlaybackRate = playbackRate;
    if (media.playbackRate !== playbackRate) media.playbackRate = playbackRate;
  }

  private selectInitialTextTrack(): void {
    const source = this.state.source;
    if (!source) return;
    const preferences = this.state.preferences;
    const track = selectTextTrack(
      source.textTracks,
      preferences.subtitleLanguage,
      preferences.audioLanguage ?? null,
    );
    this.text?.select(track?.id ?? null);
    this.dispatch({ type: "text/select", id: track?.id ?? null });
  }

  // --- store side effects -----------------------------------------------------------------

  private onStoreChange(): void {
    const prev = this.prev;
    const next = this.store.getState();
    this.prev = next;
    if (prev === next) return;

    if (prev.phase !== next.phase) {
      this.idle.setPlaying(next.phase === "playing" || next.phase === "buffering");
      this.host.onStateChange?.(next.phase);
      if (prev.phase === "playing" && next.phase === "paused") this.report("pause");
      if (next.phase === "ended" && !this.endedNotified) {
        this.endedNotified = true;
        this.report("ended", true);
        this.host.onEnded?.();
      }
      if (next.phase === "playing" && !this.advisoryShown) this.showAdvisory();
    }
    if (next.error && next.error !== prev.error) this.host.onError?.(next.error);
    if (prev.menu !== next.menu) this.idle.setHold("menu", next.menu !== null);
    if (prev.panel !== next.panel) this.idle.setHold("panel", next.panel !== null);
    if (prev.scrubbing !== next.scrubbing) this.idle.setHold("scrubbing", next.scrubbing);
    if (prev.blocked !== next.blocked) this.idle.setHold("blocked", next.blocked);
    if (prev.fullscreen !== next.fullscreen) this.host.onFullscreenChange?.(next.fullscreen);
    if (prev.preferences !== next.preferences) {
      const changed = changedPreferenceKeys(prev.preferences, next.preferences);
      if (changed.length > 0) {
        this.storage?.save(next.preferences);
        this.host.onPreferencesChange?.(next.preferences, changed);
      }
    }
    if (prev.activeQualityId !== next.activeQualityId || prev.qualityMode !== next.qualityMode) {
      this.host.onQualityChange?.(qualityChange(next));
    }
    if (prev.duration !== next.duration) this.updatePositionState();

    const running = countdownRunning(next);
    if (running && this.countdownTimer === null) this.startCountdown();
    if (!running && this.countdownTimer !== null) this.stopCountdown();
    if (countdownFinished(next.moments)) this.requestNext("autoplay");
  }

  private startCountdown(): void {
    this.countdownLast = Date.now();
    this.countdownTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.countdownLast;
      this.countdownLast = now;
      this.dispatch({ type: "moments/tick", elapsedMs: elapsed });
    }, COUNTDOWN_TICK_MS);
  }

  private stopCountdown(): void {
    if (this.countdownTimer !== null) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }

  private showAdvisory(): void {
    this.advisoryShown = true;
    this.dispatch({ type: "ui/advisory", visible: true });
    this.clearTimer("advisoryTimer");
    this.advisoryTimer = setTimeout(() => {
      this.advisoryTimer = null;
      this.dispatch({ type: "ui/advisory", visible: false });
    }, ADVISORY_MS);
  }

  private clearTimer(name: "feedbackTimer" | "advisoryTimer" | "seekReportTimer"): void {
    const timer = this[name];
    if (timer !== null) clearTimeout(timer);
    this[name] = null;
  }

  // --- progress reports -------------------------------------------------------------------

  progressSnapshot(reason: ProgressReason): ProgressReport | null {
    const request = this.request;
    const state = this.state;
    if (!request || !state.source || state.phase === "idle") return null;
    const duration = state.duration || state.source.durationHint;
    return {
      sessionId: request.sessionId,
      positionSec:
        Math.round(Math.min(state.currentTime, duration || state.currentTime) * 1000) / 1000,
      durationSec: Math.round(duration * 1000) / 1000,
      state: heartbeatState(state),
      reason,
    };
  }

  private report(reason: ProgressReason, force = false): void {
    const snapshot = this.progressSnapshot(reason);
    if (!snapshot || !this.host.onProgress) return;
    if (!force && reason !== "interval") {
      const now = Date.now();
      if (now - this.lastEventReportAt < EVENT_REPORT_MIN_GAP_MS) return;
      this.lastEventReportAt = now;
    }
    this.host.onProgress(snapshot);
  }

  private startProgressTimer(): void {
    this.stopProgressTimer();
    const tick = () => {
      this.progressTimer = setTimeout(() => {
        this.report("interval");
        tick();
      }, this.progressIntervalSec * 1000);
    };
    tick();
  }

  private stopProgressTimer(): void {
    if (this.progressTimer !== null) clearTimeout(this.progressTimer);
    this.progressTimer = null;
  }

  private scheduleSeekReport(): void {
    this.clearTimer("seekReportTimer");
    this.seekReportTimer = setTimeout(() => {
      this.seekReportTimer = null;
      this.report("seek");
    }, SEEK_REPORT_DELAY_MS);
  }

  // --- commands ---------------------------------------------------------------------------

  async play(origin: CommandOrigin = "host"): Promise<void> {
    const media = this.media;
    if (!media || this.state.blocked || this.state.phase === "error") return;
    if (this.state.phase === "ended") media.currentTime = 0;
    if (origin === "keyboard" || origin === "touch")
      this.flash({ kind: "play", nonce: nextNonce() });
    if (origin === "keyboard") this.announce(this.labels.playing);
    try {
      await media.play();
    } catch (error) {
      // AbortError: a pause or a new load superseded this play; nothing to do.
      if (errorName(error) === "NotAllowedError") this.dispatch({ type: "media/autoplay-blocked" });
    }
  }

  pause(origin: CommandOrigin = "host"): void {
    const media = this.media;
    if (!media) return;
    if (origin === "keyboard" || origin === "touch")
      this.flash({ kind: "pause", nonce: nextNonce() });
    if (origin === "keyboard") this.announce(this.labels.paused);
    media.pause();
  }

  /** Playing from the viewer's point of view (the button shows Pause). */
  isPlayingIntent(): boolean {
    const { playIntent, phase } = this.state;
    return playIntent && phase !== "ended" && phase !== "error";
  }

  togglePlay(origin: CommandOrigin = "host"): void {
    // The element's `paused` flips synchronously on play()/pause(); the store only catches up
    // when the event is dispatched. Two quick presses must see the first one.
    const media = this.media;
    const playing = media ? !media.paused && !media.ended : this.isPlayingIntent();
    if (playing) this.pause(origin);
    else void this.play(origin);
  }

  seek(positionSec: number, origin: CommandOrigin = "host"): void {
    const media = this.media;
    const state = this.state;
    if (!media || !state.source || state.phase === "error") return;
    const duration = state.duration || state.source.durationHint;
    const target = Math.max(
      0,
      Math.min(Number.isFinite(positionSec) ? positionSec : 0, duration || positionSec),
    );
    media.currentTime = target;
    this.dispatch({ type: "media/time", currentTime: target });
    if (origin === "keyboard") this.announce(this.labels.seekedTo(formatPlaybackTime(target)));
  }

  seekBy(deltaSec: number, origin: CommandOrigin = "host", streak?: number): void {
    // The element's currentTime already reflects a seek still in flight.
    const from = this.media && this.live ? this.media.currentTime : this.state.currentTime;
    this.seek(from + deltaSec, origin === "keyboard" ? "host" : origin);
    if (origin !== "keyboard" && origin !== "touch") return;
    const direction: -1 | 1 = deltaSec < 0 ? -1 : 1;
    const now = Date.now();
    const previous = this.seekStreak;
    const amount =
      streak !== undefined
        ? streak * Math.abs(deltaSec)
        : previous && previous.direction === direction && now - previous.at < 1000
          ? previous.amount + Math.abs(deltaSec)
          : Math.abs(deltaSec);
    this.seekStreak = { direction, amount, at: now };
    this.flash({ kind: "seek", direction, amountSec: amount, nonce: nextNonce() });
    if (origin === "keyboard") {
      this.announce(
        direction < 0
          ? this.labels.seekBack(Math.abs(deltaSec))
          : this.labels.seekForward(Math.abs(deltaSec)),
      );
    }
  }

  setVolume(volume: number, origin: CommandOrigin = "host"): void {
    const media = this.media;
    if (!media) return;
    const next = clampVolume(volume);
    try {
      media.volume = next;
    } catch {
      // Read-only on iOS.
    }
    media.muted = next === 0;
    if (origin === "keyboard") {
      this.flash({ kind: "volume", level: next, muted: next === 0, nonce: nextNonce() });
      this.announce(
        next === 0 ? this.labels.muted : this.labels.volumeLevel(Math.round(next * 100)),
      );
    }
  }

  volumeBy(delta: number, origin: CommandOrigin = "host"): void {
    // Read the element, not the store: `volumechange` lags a burst of key presses.
    const media = this.media;
    const current = media
      ? media.muted
        ? 0
        : media.volume
      : this.state.muted
        ? 0
        : this.state.volume;
    this.setVolume(current + delta, origin);
  }

  setMuted(muted: boolean, origin: CommandOrigin = "host"): void {
    const media = this.media;
    if (!media) return;
    if (!muted && media.volume === 0) {
      try {
        media.volume = 0.5;
      } catch {
        // Read-only on iOS.
      }
    }
    media.muted = muted;
    if (origin === "keyboard") {
      this.flash({ kind: "volume", level: muted ? 0 : media.volume, muted, nonce: nextNonce() });
      this.announce(
        muted ? this.labels.muted : this.labels.volumeLevel(Math.round(media.volume * 100)),
      );
    }
  }

  toggleMute(origin: CommandOrigin = "host"): void {
    this.setMuted(!(this.media?.muted ?? this.state.muted), origin);
  }

  setRate(rate: number, origin: CommandOrigin = "host"): void {
    const media = this.media;
    if (!media) return;
    media.defaultPlaybackRate = rate;
    media.playbackRate = rate;
    const label = formatRate(rate, "1×");
    if (origin === "keyboard") this.toast(this.labels.speedChanged(label));
    this.announce(this.labels.speedChanged(label));
  }

  setQuality(mode: "auto" | number, origin: CommandOrigin = "host"): void {
    if (!this.state.qualityControllable) return;
    this.engine?.setQuality(mode);
    this.dispatch({ type: "engine/quality-mode", mode });
    const level = mode === "auto" ? null : this.state.qualityLevels.find((l) => l.id === mode);
    const label = level ? qualityLabel(level.height) : this.labels.qualityAuto;
    if (origin !== "host") this.announce(this.labels.qualityChanged(label));
  }

  setAudioTrack(id: number, origin: CommandOrigin = "host"): void {
    const track = this.state.audioTracks.find((candidate) => candidate.id === id);
    if (!track) return;
    this.engine?.setAudioTrack(id);
    this.dispatch({
      type: "preferences/set",
      preferences: { ...this.state.preferences, audioLanguage: track.language || null },
    });
    if (origin !== "host") {
      this.announce(this.labels.audioChanged(track.name || languageLabel(track.language)));
    }
  }

  selectTextTrack(id: string | null, origin: CommandOrigin = "host"): void {
    const source = this.state.source;
    if (!source) return;
    const track: TextTrack | null = id
      ? (source.textTracks.find((t) => t.id === id) ?? null)
      : null;
    this.text?.select(track?.id ?? null);
    this.dispatch({ type: "text/select", id: track?.id ?? null });
    if (track) this.lastSubtitleLanguage = track.language;
    this.dispatch({
      type: "preferences/set",
      preferences: { ...this.state.preferences, subtitleLanguage: track ? track.language : null },
    });
    const message = track
      ? this.labels.subtitlesOn(track.label)
      : this.labels.subtitlesOn(this.labels.subtitlesOff);
    if (origin === "keyboard") this.toast(message);
    if (origin !== "host") this.announce(message);
  }

  toggleCaptions(origin: CommandOrigin = "host"): void {
    const source = this.state.source;
    if (!source) return;
    const options = menuTextTracks(source.textTracks);
    const current = source.textTracks.find((t) => t.id === this.state.textTrackId);
    if (current && !current.forced) {
      this.selectTextTrack(null, origin);
      return;
    }
    const preferred = this.lastSubtitleLanguage ?? this.state.preferences.subtitleLanguage ?? null;
    const pick =
      (preferred ? selectTextTrack(options, preferred, null) : null) ??
      options.find((t) => t.default) ??
      options[0] ??
      null;
    if (pick) this.selectTextTrack(pick.id, origin);
  }

  async toggleFullscreen(): Promise<void> {
    if (this.state.fullscreen) await this.exitFullscreen();
    else await this.enterFullscreen();
  }

  async enterFullscreen(): Promise<void> {
    if (!this.root || !this.media) return;
    try {
      await enterFullscreen(this.root, this.media);
    } catch {
      // Refused (no user gesture, iframe without allowfullscreen): stay inline.
    }
  }

  async exitFullscreen(): Promise<void> {
    if (!this.root || !this.media) return;
    try {
      await exitFullscreen(this.root, this.media);
    } catch {
      // Already left.
    }
  }

  async togglePip(): Promise<void> {
    if (!this.media) return;
    try {
      await togglePictureInPicture(this.media);
    } catch {
      // Refused or unsupported.
    }
  }

  skipMoment(): boolean {
    const source = this.state.source;
    if (!source) return false;
    const window = activeSkipWindow(source.markers, this.state.currentTime);
    if (!window) return false;
    this.seek(window.endSec);
    return true;
  }

  requestNext(reason: NextEpisodeReason): void {
    const state = this.state;
    if (!state.source?.hasNextEpisode || state.moments.nextRequested) return;
    this.dispatch({ type: "moments/next-requested" });
    this.host.onNextEpisode?.(reason);
  }

  dismissCredits(): void {
    this.dispatch({ type: "moments/dismiss-credits" });
  }

  replay(): void {
    this.seek(0);
    void this.play("pointer");
  }

  openMenu(menu: MenuId | null): void {
    this.dispatch({ type: "ui/menu", menu });
  }

  toggleMenu(menu: MenuId): void {
    this.openMenu(this.state.menu === menu ? null : menu);
  }

  openPanel(panel: PanelId | null): void {
    this.dispatch({ type: "ui/panel", panel });
  }

  setScrubbing(value: boolean): void {
    this.dispatch({ type: "ui/scrubbing", value });
  }

  // --- input ------------------------------------------------------------------------------

  activity(kind: ActivityKind): void {
    this.idle.activity(kind);
  }

  tap(zone: TapZone): void {
    this.taps.tap(zone);
  }

  pointerLeft(): void {
    this.idle.hideNow();
  }

  setHold(reason: string, active: boolean): void {
    this.idle.setHold(reason, active);
  }

  /** Run a keyboard shortcut. Returns true when the key was used (caller prevents default). */
  handleKey(event: {
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    repeat?: boolean;
  }): boolean {
    if (this.state.blocked) return false;
    const command = resolveKeyCommand(event);
    if (!command) return false;
    const handled = this.execute(command, "keyboard");
    if (handled && command.type !== "escape") this.idle.activity("keyboard");
    return handled;
  }

  execute(command: PlayerCommand, origin: CommandOrigin): boolean {
    const state = this.state;
    const duration = state.duration || state.source?.durationHint || 0;
    switch (command.type) {
      case "togglePlay":
        this.togglePlay(origin);
        return true;
      case "seekBy":
        this.seekBy(command.seconds, origin);
        return true;
      case "seekToFraction":
        this.seek(duration * command.fraction, origin);
        return true;
      case "seekToStart":
        this.seek(0, origin);
        return true;
      case "seekToEnd":
        this.seek(duration, origin);
        return true;
      case "volumeBy":
        this.volumeBy(command.delta, origin);
        return true;
      case "toggleMute":
        this.toggleMute(origin);
        return true;
      case "toggleFullscreen":
        void this.toggleFullscreen();
        return true;
      case "toggleCaptions":
        this.toggleCaptions(origin);
        return true;
      case "togglePip":
        void this.togglePip();
        return true;
      case "skipMoment":
        return this.skipMoment();
      case "nextEpisode":
        if (!state.source?.hasNextEpisode) return false;
        this.requestNext("user");
        return true;
      case "rateStep":
        this.setRate(
          stepRate(this.media?.playbackRate ?? state.playbackRate, command.direction),
          origin,
        );
        return true;
      case "escape":
        if (state.menu) {
          this.openMenu(null);
          return true;
        }
        if (state.panel) {
          this.openPanel(null);
          return true;
        }
        if (state.fullscreen) {
          void this.exitFullscreen();
          return true;
        }
        return false;
    }
  }

  // --- feedback ---------------------------------------------------------------------------

  private flash(feedback: Feedback): void {
    this.dispatch({ type: "ui/feedback", feedback });
    this.clearTimer("feedbackTimer");
    const duration = feedback.kind === "toast" ? 1600 : feedback.kind === "seek" ? 900 : 800;
    this.feedbackTimer = setTimeout(() => {
      this.feedbackTimer = null;
      this.dispatch({ type: "ui/feedback", feedback: null });
    }, duration);
  }

  private toast(text: string): void {
    this.flash({ kind: "toast", text, nonce: nextNonce() });
  }

  announce(text: string): void {
    this.dispatch({ type: "ui/announce", text });
  }

  // --- Media Session (lock screen, hardware media keys) -----------------------------------

  private setMediaSessionMetadata(): void {
    const session = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    const info = this.request?.mediaSession;
    if (!session || !info || typeof MediaMetadata === "undefined") return;
    try {
      const artwork = info.artwork
        ? info.artwork.widths
            .filter((width) => width >= 256)
            .slice(0, 2)
            .map((width) => ({
              src: imageUrl(info.artwork as ImageSet, width, info.artwork?.formats[0] ?? "webp"),
              sizes: `${width}x${Math.round(width / (info.artwork?.aspectRatio ?? 1))}`,
            }))
        : [];
      session.metadata = new MediaMetadata({ title: info.title, artist: info.artist, artwork });
      const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
        ["play", () => void this.play("host")],
        ["pause", () => this.pause("host")],
        ["seekbackward", (details) => this.seekBy(-(details.seekOffset ?? SEEK_STEP_SEC))],
        ["seekforward", (details) => this.seekBy(details.seekOffset ?? SEEK_STEP_SEC)],
        ["seekto", (details) => details.seekTime !== undefined && this.seek(details.seekTime)],
        ["nexttrack", this.request?.source.hasNextEpisode ? () => this.requestNext("user") : null],
      ];
      for (const [action, handler] of handlers) {
        try {
          session.setActionHandler(action, handler);
        } catch {
          // Action not supported by this browser.
        }
      }
    } catch {
      // Media Session unavailable (insecure context, old browser).
    }
  }

  private updatePositionState(): void {
    const session = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    const media = this.media;
    if (
      !session?.setPositionState ||
      !media ||
      !Number.isFinite(media.duration) ||
      media.duration <= 0
    )
      return;
    try {
      session.setPositionState({
        duration: media.duration,
        position: Math.min(media.currentTime, media.duration),
        playbackRate: media.playbackRate || 1,
      });
    } catch {
      // Inconsistent values mid-seek: the next update fixes it.
    }
  }

  private clearMediaSession(): void {
    const session = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!session) return;
    try {
      session.metadata = null;
      for (const action of [
        "play",
        "pause",
        "seekbackward",
        "seekforward",
        "seekto",
        "nexttrack",
      ] as const) {
        session.setActionHandler(action, null);
      }
    } catch {
      // Unsupported.
    }
  }
}

function errorName(error: unknown): string {
  return error && typeof error === "object" && "name" in error ? String(error.name) : String(error);
}

export function qualityChange(state: PlayerState): QualityChange {
  const active = state.qualityLevels.find((level) => level.id === state.activeQualityId) ?? null;
  const selected =
    state.qualityMode === "auto"
      ? null
      : state.qualityLevels.find((level) => level.id === state.qualityMode);
  return {
    selection: selected ? { height: selected.height } : "auto",
    active: active ? { width: active.width, height: active.height, bitrate: active.bitrate } : null,
  };
}
