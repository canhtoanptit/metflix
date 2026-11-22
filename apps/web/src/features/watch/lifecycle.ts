/**
 * The watch page's playback lifecycle, as a plain object with no React and no DOM, so every
 * rule here is unit-tested without a browser (test/watch-lifecycle.test.ts).
 *
 *   open(target) ──► POST /playback/sessions ──► ready (session)   ──► the <Player> plays it
 *                         │ 409/402/403/404/network                       │
 *                         ▼                                               ▼ onProgress reports
 *                      blocked (designed screen, retry)        POST …/heartbeat (keepalive on
 *                                                              hide); 410 → blocked
 *                                                                         │ leave / unload
 *                                                                         ▼
 *                                                     DELETE …/sessions/:id + final position
 *
 * Rules it enforces:
 * - Only the newest `open` wins: a superseded or disposed request's session is released at once.
 * - Heartbeats go to the session the report belongs to (reports can trail a source swap), but
 *   only failures of the *current* session change what the member sees.
 * - Switching episodes records the outgoing episode's final position *before* the new session
 *   starts (starting one replaces this device's stream slot, which ends the old session).
 * - An expired media token is recovered transparently at the failure position, a bounded
 *   number of times.
 * - Leaving (in the app or by closing the page) is one request: the release carries the final
 *   position, so nothing can arrive after the slot is freed and be refused.
 * - Resuming after a pause reports at once: the server credits watching only over intervals
 *   that began playing.
 */
import {
  type ActiveStream,
  type ApiClient,
  ApiError,
  type MaturityLevel,
  type MembershipStatus,
  type PlaybackSession,
  type SubscriptionStatus,
} from "@webflix/contracts";
import type { PlaybackPhase, PlayerError, ProgressReason, ProgressReport } from "@webflix/player";

export interface WatchTarget {
  titleId: string;
  episodeId?: string | undefined;
  /** Override the stored resume position (`?t=`, token recovery, "resume" after a block). */
  startPositionSec?: number | undefined;
}

export type WatchBlock =
  | { kind: "stream-limit"; limit: number; activeStreams: ActiveStream[] }
  | { kind: "ended-elsewhere" }
  | { kind: "signed-out" }
  | { kind: "profile-required" }
  | {
      kind: "membership";
      subscriptionStatus: SubscriptionStatus;
      /** Milestone 2: the membership's state, which decides the way back (§5.2). */
      membershipStatus?: MembershipStatus;
    }
  | { kind: "maturity"; maturity: MaturityLevel; ceiling: MaturityLevel }
  | { kind: "not-found" }
  | { kind: "unavailable" }
  | { kind: "offline" }
  | { kind: "error"; error: unknown };

export interface WatchState {
  /** `starting`: no session yet; `ready`: a session is playing; `blocked`: see `block`. */
  status: "starting" | "ready" | "blocked";
  /** The session the player shows (kept while blocked, so the overlay sits over the picture). */
  session: PlaybackSession | null;
  block: WatchBlock | null;
  /** A new session is being created (switching episode, recovering, retrying). */
  switching: boolean;
  /** Cadence for the player's progress reports, from the last heartbeat acknowledgement. */
  heartbeatIntervalSec: number;
  /** Heartbeats are failing for network reasons; playback continues from the buffer. */
  connection: "online" | "offline";
  /** Last position reported for the current session (seconds). */
  positionSec: number;
}

type PlaybackApi = Pick<
  ApiClient,
  "createPlaybackSession" | "sendHeartbeat" | "endPlaybackSession"
>;

export interface WatchLifecycleOptions {
  api: PlaybackApi;
  /** A progress sample from the player right now (final heartbeat when leaving or switching). */
  snapshot?: (reason: ProgressReason) => ProgressReport | null;
  /** A new session became current (update the URL, the document title…). */
  onSessionChange?: (session: PlaybackSession) => void;
  now?: () => number;
}

/** Token recoveries allowed within `RECOVERY_WINDOW_MS` before giving up with an error. */
export const MAX_RECOVERIES = 3;
export const RECOVERY_WINDOW_MS = 60_000;
const DEFAULT_HEARTBEAT_SEC = 30;

const INITIAL_STATE: WatchState = {
  status: "starting",
  session: null,
  block: null,
  switching: false,
  heartbeatIntervalSec: DEFAULT_HEARTBEAT_SEC,
  connection: "online",
  positionSec: 0,
};

/** Map a failed `POST /playback/sessions` onto what the member is shown. */
export function blockFromStartError(error: unknown): WatchBlock {
  if (ApiError.is(error, "stream_limit_reached")) {
    return {
      kind: "stream-limit",
      limit: error.problem.limit,
      activeStreams: error.problem.activeStreams,
    };
  }
  if (ApiError.is(error, "subscription_required")) {
    return {
      kind: "membership",
      subscriptionStatus: error.problem.subscriptionStatus,
      ...(error.problem.membershipStatus
        ? { membershipStatus: error.problem.membershipStatus }
        : {}),
    };
  }
  if (ApiError.is(error, "maturity_restricted")) {
    return {
      kind: "maturity",
      maturity: error.problem.maturity,
      ceiling: error.problem.profileMaturityCeiling,
    };
  }
  if (ApiError.is(error, "not_found")) return { kind: "not-found" };
  if (ApiError.is(error, "media_unavailable")) return { kind: "unavailable" };
  if (ApiError.is(error, "unauthenticated")) return { kind: "signed-out" };
  if (ApiError.is(error, "profile_required")) return { kind: "profile-required" };
  if (isNetworkFailure(error)) return { kind: "offline" };
  return { kind: "error", error };
}

function isNetworkFailure(error: unknown): boolean {
  return (
    ApiError.is(error, "network_error") ||
    (ApiError.is(error, "unexpected_response") && (error.status === 502 || error.status === 504))
  );
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

export class WatchLifecycle {
  private state: WatchState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly api: PlaybackApi;
  private readonly options: WatchLifecycleOptions;
  private readonly now: () => number;
  /** Increments with every `open`; responses of older generations are stale. */
  private generation = 0;
  private inFlight: AbortController | null = null;
  /** Sessions this page ended or that the server ended: never heartbeat them again. */
  private readonly finished = new Set<string>();
  private recoveries: number[] = [];
  private lastTarget: WatchTarget | null = null;
  private lastPhase: PlaybackPhase | null = null;
  private disposed = false;
  private pendingHeartbeat: Promise<unknown> = Promise.resolve();

  constructor(options: WatchLifecycleOptions) {
    this.options = options;
    this.api = options.api;
    this.now = options.now ?? Date.now;
  }

  // --- store ------------------------------------------------------------------------------------

  getState = (): WatchState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<WatchState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // --- starting and switching -------------------------------------------------------------------

  /**
   * Start playback of `target` (also: next episode, episode from the panel, retry, recovery).
   * Resolves once the outcome is in the state.
   */
  async open(target: WatchTarget): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    this.lastTarget = target;

    const previous = this.state.session;
    const switching =
      previous !== null && !this.finished.has(previous.id) && !isSameItem(target, previous);
    this.set({ switching: true, ...(previous ? {} : { status: "starting", block: null }) });

    // Starting a session replaces this device's stream slot and ends the outgoing session on
    // the server, so record where the member stopped first.
    if (switching && previous) await this.flushFinalHeartbeat(previous, "unload");
    if (generation !== this.generation) return;

    let session: PlaybackSession;
    try {
      session = await this.api.createPlaybackSession(
        {
          body: {
            titleId: target.titleId,
            ...(target.episodeId ? { episodeId: target.episodeId } : {}),
            ...(target.startPositionSec !== undefined
              ? { startPositionSec: Math.max(0, target.startPositionSec) }
              : {}),
          },
        },
        { signal: controller.signal },
      );
    } catch (error) {
      if (generation !== this.generation || this.disposed || isAbort(error)) return;
      this.inFlight = null;
      this.set({ status: "blocked", block: blockFromStartError(error), switching: false });
      return;
    }

    if (generation !== this.generation || this.disposed) {
      // Superseded (another open) or the page is gone: give the slot back immediately.
      void this.release(session.id);
      return;
    }
    this.inFlight = null;
    if (previous && previous.id !== session.id) this.finished.add(previous.id);
    this.set({
      status: "ready",
      session,
      block: null,
      switching: false,
      heartbeatIntervalSec: session.heartbeatIntervalSec,
      connection: "online",
      positionSec: session.resumePositionSec,
    });
    this.options.onSessionChange?.(session);
  }

  /** "Try again" / "Resume watching" from a blocked screen: same item, current position. */
  retry(): Promise<void> {
    const current = this.state.session;
    const target = this.lastTarget;
    if (current && (!target || isSameItem(target, current))) {
      return this.open({ ...targetOf(current), startPositionSec: this.state.positionSec });
    }
    return target ? this.open(target) : Promise.resolve();
  }

  // --- progress -------------------------------------------------------------------------------

  /** A progress report from the player (interval, pause, seek, ended, hidden, unload). */
  report(report: ProgressReport): Promise<void> {
    const current = this.state.session;
    if (current?.id === report.sessionId) this.set({ positionSec: report.positionSec });
    if (this.finished.has(report.sessionId)) return Promise.resolve();
    // Once blocked over a revoked session, nothing more goes out for it.
    if (this.state.status === "blocked" && current?.id === report.sessionId) {
      return Promise.resolve();
    }
    const keepalive = report.reason === "hidden" || report.reason === "unload";
    const sent = this.heartbeat(report, keepalive);
    this.pendingHeartbeat = sent;
    return sent;
  }

  /**
   * The player's phase changed. A resume after a pause is reported at once: an interval that
   * began paused earns no watch time on the server, so without this report the time from the
   * resume to the next interval report would not count.
   */
  phase(phase: PlaybackPhase): void {
    const resumed = phase === "playing" && this.lastPhase === "paused";
    this.lastPhase = phase;
    if (!resumed || this.disposed) return;
    const sample = this.options.snapshot?.("interval");
    if (sample) void this.report(sample);
  }

  private async heartbeat(report: ProgressReport, keepalive: boolean): Promise<void> {
    try {
      const ack = await this.api.sendHeartbeat(
        { params: { id: report.sessionId }, body: heartbeatBody(report) },
        keepalive ? { keepalive: true } : undefined,
      );
      if (this.state.session?.id === report.sessionId) {
        this.set({ heartbeatIntervalSec: ack.heartbeatIntervalSec, connection: "online" });
      }
    } catch (error) {
      this.onHeartbeatError(report.sessionId, error);
    }
  }

  private onHeartbeatError(sessionId: string, error: unknown): void {
    const isCurrent = this.state.session?.id === sessionId;
    if (ApiError.is(error, "playback_session_ended") || ApiError.is(error, "not_found")) {
      this.finished.add(sessionId);
      // Expected for a session this page already switched away from; news for the current one.
      if (isCurrent && !this.disposed && !this.state.switching) {
        this.set({ status: "blocked", block: { kind: "ended-elsewhere" } });
      }
      return;
    }
    if (!isCurrent || this.disposed) return;
    if (ApiError.is(error, "unauthenticated")) {
      this.finished.add(sessionId);
      this.set({ status: "blocked", block: { kind: "signed-out" } });
    } else if (ApiError.is(error, "profile_required")) {
      this.finished.add(sessionId);
      this.set({ status: "blocked", block: { kind: "profile-required" } });
    } else if (isNetworkFailure(error)) {
      // The buffer keeps playing; the next report (or `online()`) tries again.
      this.set({ connection: "offline" });
    }
  }

  /** The browser is back online: start over if offline blocked us, else report right away. */
  online(): void {
    if (this.disposed) return;
    if (this.state.status === "blocked" && this.state.block?.kind === "offline") {
      void this.retry();
      return;
    }
    if (this.state.connection === "offline") {
      const sample = this.options.snapshot?.("interval");
      if (sample) void this.report(sample);
    }
  }

  /**
   * The page is visible again. Browsers throttle a hidden tab's timers (Chrome stretches them to
   * a minute after five minutes hidden with nothing audible), so a paused player in a background
   * tab may be well past its interval report: report now, so a sign-out or a session ended
   * elsewhere shows the moment the member looks, never a frame that will die at the next tick.
   */
  visible(): void {
    if (this.disposed || this.state.status !== "ready") return;
    const sample = this.options.snapshot?.("interval");
    if (sample) void this.report(sample);
  }

  // --- player errors --------------------------------------------------------------------------

  /** Fatal player errors the host can do something about. */
  async playerError(error: PlayerError): Promise<void> {
    const session = this.state.session;
    if (!session || this.disposed) return;
    if (error.code === "forbidden") {
      // The signed media token expired (or was revoked): a new session at the same position.
      const now = this.now();
      this.recoveries = this.recoveries.filter((at) => now - at < RECOVERY_WINDOW_MS);
      if (this.recoveries.length >= MAX_RECOVERIES) {
        this.set({ status: "blocked", block: { kind: "error", error } });
        return;
      }
      this.recoveries.push(now);
      this.finished.add(session.id);
      await this.open({
        titleId: session.titleId,
        episodeId: session.episodeId ?? undefined,
        startPositionSec: error.positionSec,
      });
      return;
    }
    if (error.code === "not_found") {
      // A playlist answering 410 means the stream slot is gone; a heartbeat tells us which.
      try {
        await this.api.sendHeartbeat({
          params: { id: session.id },
          body: {
            positionSec: Math.max(0, error.positionSec),
            durationSec: session.durationSec,
            state: "paused",
          },
        });
        this.set({ status: "blocked", block: { kind: "unavailable" } });
      } catch (probe) {
        this.onHeartbeatError(session.id, probe);
        if (this.state.status !== "blocked") {
          this.set({ status: "blocked", block: { kind: "unavailable" } });
        }
      }
    }
  }

  // --- leaving --------------------------------------------------------------------------------

  /**
   * Leave the watch page: one release that carries the final position and frees the stream
   * slot. Resolves once it has been answered (callers refresh Continue Watching after it).
   */
  finish(): Promise<void> {
    if (this.disposed) return this.pendingHeartbeat.then(noop, noop);
    this.disposed = true;
    this.generation++;
    this.inFlight?.abort();
    const session = this.state.session;
    if (!session || this.finished.has(session.id)) return Promise.resolve();
    return this.release(session.id, this.finalReport(session));
  }

  /**
   * The page is being unloaded (tab closed, reload, navigation away from the app). Nothing can
   * be awaited any more: the release goes out now with `keepalive`, carrying the final
   * position, so the slot is free at once (a member who closes a tab and turns on the TV must
   * not see "too many screens") and the position cannot arrive after it and be refused.
   */
  pageHide(): void {
    const session = this.state.session;
    if (!session || this.finished.has(session.id)) return;
    void this.release(session.id, this.finalReport(session));
  }

  /** Restored from the back/forward cache after `pageHide` ended the session: start again. */
  pageShow(persisted: boolean): void {
    const session = this.state.session;
    if (!persisted || this.disposed || !session || !this.finished.has(session.id)) return;
    void this.open({
      titleId: session.titleId,
      episodeId: session.episodeId ?? undefined,
      startPositionSec: this.state.positionSec,
    });
  }

  /** Where the player is now, if it is playing `session`. */
  private finalReport(session: PlaybackSession): ProgressReport | null {
    const sample = this.options.snapshot?.("unload");
    return sample && sample.sessionId === session.id ? sample : null;
  }

  private flushFinalHeartbeat(session: PlaybackSession, reason: ProgressReason): Promise<void> {
    const sample = this.options.snapshot?.(reason);
    if (!sample || sample.sessionId !== session.id || this.finished.has(session.id)) {
      return this.pendingHeartbeat.then(noop, noop);
    }
    const sent = this.heartbeat(sample, true);
    this.pendingHeartbeat = sent;
    return sent;
  }

  /** Free the stream slot; with `final`, the release also records where the member stopped. */
  private release(sessionId: string, final: ProgressReport | null = null): Promise<void> {
    this.finished.add(sessionId);
    // A back/forward restore starts again from here.
    if (final && this.state.session?.id === sessionId) this.set({ positionSec: final.positionSec });
    return this.api
      .endPlaybackSession(
        final
          ? { params: { id: sessionId }, body: heartbeatBody(final) }
          : { params: { id: sessionId } },
        { keepalive: true },
      )
      .catch(noop);
  }
}

function heartbeatBody(report: ProgressReport) {
  return {
    positionSec: Math.max(0, report.positionSec),
    durationSec: Math.max(0, report.durationSec),
    state: report.state,
  };
}

function targetOf(session: PlaybackSession): WatchTarget {
  return { titleId: session.titleId, episodeId: session.episodeId ?? undefined };
}

/** The target asks for what the session plays (no episode = whatever the server resumed). */
export function isSameItem(target: WatchTarget, session: PlaybackSession): boolean {
  return (
    target.titleId === session.titleId &&
    (target.episodeId === undefined || target.episodeId === session.episodeId)
  );
}

function noop(): void {}
