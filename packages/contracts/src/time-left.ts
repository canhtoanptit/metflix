/**
 * Time left in a title or episode, worded the same way everywhere: browse (hover preview,
 * Continue Watching, the detail overlay) and the player. Zod-free and dependency-free, so any
 * runtime can import it (`@webflix/contracts`).
 *
 * Rules:
 * - It says what is left, never "X of Y": "12m left", "1h 5m left".
 * - Under two minutes it counts seconds ("1m 45s left", "40s left"), so a nearly finished title
 *   never reads as "0m left" or "1m left" for a few seconds.
 * - Minutes are rounded down from the remaining seconds plus 30 (nearest minute, a half rounding
 *   up), never down to zero: a title with time left always shows time left.
 * - The bar and the label come from the same two numbers (`progressFraction` and
 *   `formatTimeLeft` of one position and one duration), so they always agree.
 * - Completed (the server's call: credits reached, or the player saw the end) is "Finished"
 *   under a full bar, wherever the saved position stopped. Pass a `Progress` as it comes from
 *   the API and its `completed` flag is honoured.
 */

export interface PlaybackPoint {
  /** Seconds watched. */
  positionSec: number;
  /** Playable duration in seconds (the same base the player reports progress on). */
  durationSec: number;
  /**
   * Watched to the end as far as the server is concerned (`Progress.completed`): finished,
   * even when the saved position stops at the credits.
   */
  completed?: boolean;
}

/** Seconds still to watch, never negative (0 when the duration is unknown or it is completed). */
export function timeLeftSec({ positionSec, durationSec, completed }: PlaybackPoint): number {
  if (completed) return 0;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const position = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  return Math.max(0, durationSec - position);
}

/** Fraction watched, 0–1, from the same numbers as the label (1 once completed). */
export function progressFraction(point: PlaybackPoint | null | undefined): number {
  if (point?.completed) return 1;
  if (!point || !Number.isFinite(point.durationSec) || point.durationSec <= 0) return 0;
  const position = Number.isFinite(point.positionSec) ? point.positionSec : 0;
  return Math.min(1, Math.max(0, position / point.durationSec));
}

interface Parts {
  hours: number;
  minutes: number;
  seconds: number | null;
}

function parts(remainingSec: number): Parts | null {
  const left = Math.max(0, remainingSec);
  if (left < 0.5) return null;
  if (left < 120) {
    const whole = Math.max(1, Math.round(left));
    return { hours: 0, minutes: Math.floor(whole / 60), seconds: whole % 60 };
  }
  const minutes = Math.max(2, Math.floor((left + 30) / 60));
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60, seconds: null };
}

/**
 * "12m left", "1h 5m left", "2h left", "1m 45s left", "40s left"; "Finished" when nothing is
 * left or it is completed. `formatTimeLeft({ positionSec: 300, durationSec: 1020 })` →
 * "12m left".
 */
export function formatTimeLeft(point: PlaybackPoint): string {
  const p = parts(timeLeftSec(point));
  if (!p) return "Finished";
  if (p.seconds !== null) {
    if (p.minutes === 0) return `${p.seconds}s left`;
    return p.seconds === 0 ? `${p.minutes}m left` : `${p.minutes}m ${p.seconds}s left`;
  }
  if (p.hours === 0) return `${p.minutes}m left`;
  return p.minutes === 0 ? `${p.hours}h left` : `${p.hours}h ${p.minutes}m left`;
}

/** The same, spelled out for screen readers: "12 minutes left", "1 minute 45 seconds left". */
export function formatTimeLeftSpoken(point: PlaybackPoint): string {
  const p = parts(timeLeftSec(point));
  if (!p) return "Finished";
  const unit = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`;
  const words: string[] = [];
  if (p.hours > 0) words.push(unit(p.hours, "hour"));
  if (p.minutes > 0) words.push(unit(p.minutes, "minute"));
  if (p.seconds !== null && p.seconds > 0) words.push(unit(p.seconds, "second"));
  return `${words.join(" ")} left`;
}
