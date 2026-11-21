/**
 * "Moments": Skip Intro / Skip Recap windows, the credits boundary, the next-episode countdown
 * and the end screen. All pure so the timing rules are unit-tested.
 */
import type { PlaybackMarkers } from "@webflix/contracts";

export type SkipKind = "intro" | "recap";

export interface SkipWindow {
  kind: SkipKind;
  startSec: number;
  endSec: number;
}

/**
 * A skip button is hidden during the last second of its window: skipping would land where
 * playback already is and the button would vanish under the pointer.
 */
export const SKIP_TAIL_SEC = 1;

/** The skip window covering `positionSec`, if any. Recap wins when the two overlap. */
export function activeSkipWindow(markers: PlaybackMarkers, positionSec: number): SkipWindow | null {
  for (const kind of ["recap", "intro"] as const) {
    const range = markers[kind];
    if (!range) continue;
    if (positionSec >= range.startSec && positionSec < range.endSec - SKIP_TAIL_SEC) {
      return { kind, startSec: range.startSec, endSec: range.endSec };
    }
  }
  return null;
}

/**
 * Without a credits marker, the next-episode card appears this long before the end. Long
 * enough for the countdown, short enough not to cover the final scene of an unmarked title.
 */
export const CREDITS_FALLBACK_SEC = 12;

/** Where the credits begin: the marker, else a fallback before the end, else unknown (null). */
export function creditsStartSec(markers: PlaybackMarkers, durationSec: number): number | null {
  if (markers.creditsStartSec !== null && markers.creditsStartSec > 0) {
    return Number.isFinite(durationSec) && durationSec > 0
      ? Math.min(markers.creditsStartSec, durationSec)
      : markers.creditsStartSec;
  }
  if (!Number.isFinite(durationSec) || durationSec <= CREDITS_FALLBACK_SEC * 2) return null;
  return durationSec - CREDITS_FALLBACK_SEC;
}

export interface MomentsState {
  /** "Watch credits" was chosen during this pass through the credits. */
  creditsDismissed: boolean;
  /** Remaining countdown in ms while counting; null when no countdown runs. */
  countdownMs: number | null;
  /** The host was already asked to move to the next episode (never twice per source). */
  nextRequested: boolean;
}

export const INITIAL_MOMENTS: MomentsState = {
  creditsDismissed: false,
  countdownMs: null,
  nextRequested: false,
};

export interface MomentsContext {
  positionSec: number;
  durationSec: number;
  ended: boolean;
  markers: PlaybackMarkers;
  hasNextEpisode: boolean;
  autoplayNext: boolean;
  countdownSec: number;
}

/**
 * Advance the moments state after a time update or an `ended` event. Seeking back before the
 * credits re-arms everything; entering the credits starts the countdown when autoplay is on.
 */
export function updateMoments(state: MomentsState, ctx: MomentsContext): MomentsState {
  const credits = creditsStartSec(ctx.markers, ctx.durationSec);
  const inCredits = ctx.ended || (credits !== null && ctx.positionSec >= credits);
  if (!inCredits) {
    return state.creditsDismissed || state.countdownMs !== null || state.nextRequested
      ? INITIAL_MOMENTS
      : state;
  }
  if (!ctx.hasNextEpisode || state.nextRequested) return state;
  let next = state;
  // Reaching the end after "Watch credits" brings the card back.
  if (ctx.ended && next.creditsDismissed) next = { ...next, creditsDismissed: false };
  if (ctx.autoplayNext && !next.creditsDismissed && next.countdownMs === null) {
    next = { ...next, countdownMs: ctx.countdownSec * 1000 };
  }
  if (!ctx.autoplayNext && next.countdownMs !== null) next = { ...next, countdownMs: null };
  return next;
}

/** Count down by `elapsedMs`; the caller ticks only while the countdown should run. */
export function tickCountdown(state: MomentsState, elapsedMs: number): MomentsState {
  if (state.countdownMs === null || state.countdownMs === 0 || state.nextRequested) return state;
  return { ...state, countdownMs: Math.max(0, state.countdownMs - Math.max(0, elapsedMs)) };
}

/** True once the countdown has run out and the host has not been asked yet. */
export function countdownFinished(state: MomentsState): boolean {
  return state.countdownMs === 0 && !state.nextRequested;
}

export interface MomentsView {
  skip: SkipWindow | null;
  /** The next-episode card: `countdown` while counting, `manual` when autoplay is off. */
  nextUp: null | { mode: "countdown"; remainingMs: number; totalMs: number } | { mode: "manual" };
  /** The end screen for the last episode / a movie: during credits, or after the end. */
  endScreen: null | "credits" | "ended";
  inCredits: boolean;
}

/** What the overlays should show right now. */
export function viewMoments(state: MomentsState, ctx: MomentsContext): MomentsView {
  const credits = creditsStartSec(ctx.markers, ctx.durationSec);
  const inCredits = ctx.ended || (credits !== null && ctx.positionSec >= credits);
  const skip = ctx.ended ? null : activeSkipWindow(ctx.markers, ctx.positionSec);
  if (!inCredits) return { skip, nextUp: null, endScreen: null, inCredits };
  if (ctx.hasNextEpisode) {
    if (state.creditsDismissed || state.nextRequested) {
      return { skip, nextUp: null, endScreen: null, inCredits };
    }
    const nextUp =
      state.countdownMs !== null
        ? {
            mode: "countdown" as const,
            remainingMs: state.countdownMs,
            totalMs: ctx.countdownSec * 1000,
          }
        : { mode: "manual" as const };
    return { skip, nextUp, endScreen: null, inCredits };
  }
  if (ctx.ended) return { skip, nextUp: null, endScreen: "ended", inCredits };
  // A credits marker shrinks the picture into the end screen; the fallback (no marker) waits
  // for the real end, because "12 s before the end" may still be story.
  const marked = ctx.markers.creditsStartSec !== null;
  return {
    skip,
    nextUp: null,
    endScreen: marked && !state.creditsDismissed ? "credits" : null,
    inCredits,
  };
}
