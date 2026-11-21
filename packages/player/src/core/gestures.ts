/**
 * Touch gestures on the picture: a single tap toggles the controls; a double tap on the left
 * or right third seeks back / forward, and further taps on the same side keep seeking
 * (10 s, 20 s, 30 s…). Pure apart from the injected scheduler.
 */
import type { Scheduler } from "./idle.ts";

export type TapZone = "left" | "center" | "right";

export interface TapRecognizerConfig {
  /** Max gap between the taps of a double tap. */
  doubleTapMs: number;
  /** How long a seek streak stays open for another tap. */
  streakMs: number;
}

export const DEFAULT_TAP_CONFIG: TapRecognizerConfig = { doubleTapMs: 280, streakMs: 700 };

export interface TapHandlers {
  onSingleTap(zone: TapZone): void;
  /** `streak` counts the seek taps so far (1 for the double tap itself). */
  onSeekTap(direction: -1 | 1, streak: number): void;
}

export function zoneForPosition(x: number, width: number): TapZone {
  if (width <= 0) return "center";
  const ratio = x / width;
  if (ratio < 1 / 3) return "left";
  if (ratio > 2 / 3) return "right";
  return "center";
}

export interface TapRecognizer {
  tap(zone: TapZone): void;
  dispose(): void;
}

export function createTapRecognizer(
  config: TapRecognizerConfig,
  scheduler: Scheduler,
  handlers: TapHandlers,
): TapRecognizer {
  let pending: { zone: TapZone; timer: unknown } | null = null;
  let streak: { direction: -1 | 1; count: number; timer: unknown } | null = null;

  const endStreakLater = () => {
    if (!streak) return;
    scheduler.clearTimeout(streak.timer);
    streak.timer = scheduler.setTimeout(() => {
      streak = null;
    }, config.streakMs);
  };

  return {
    tap(zone) {
      const direction = zone === "left" ? -1 : zone === "right" ? 1 : null;
      if (streak && direction === streak.direction) {
        streak.count += 1;
        handlers.onSeekTap(direction, streak.count);
        endStreakLater();
        return;
      }
      if (pending && direction !== null && pending.zone === zone) {
        scheduler.clearTimeout(pending.timer);
        pending = null;
        if (streak) scheduler.clearTimeout(streak.timer);
        streak = { direction, count: 1, timer: null };
        handlers.onSeekTap(direction, 1);
        endStreakLater();
        return;
      }
      if (pending) {
        // A second tap elsewhere: the first one was a single tap after all.
        scheduler.clearTimeout(pending.timer);
        const first = pending.zone;
        pending = null;
        handlers.onSingleTap(first);
        if (zone === "center") {
          handlers.onSingleTap(zone);
          return;
        }
      }
      if (streak) {
        scheduler.clearTimeout(streak.timer);
        streak = null;
      }
      if (zone === "center") {
        // Nothing to disambiguate in the middle: respond immediately.
        handlers.onSingleTap(zone);
        return;
      }
      const timer = scheduler.setTimeout(() => {
        pending = null;
        handlers.onSingleTap(zone);
      }, config.doubleTapMs);
      pending = { zone, timer };
    },
    dispose() {
      if (pending) scheduler.clearTimeout(pending.timer);
      if (streak) scheduler.clearTimeout(streak.timer);
      pending = null;
      streak = null;
    },
  };
}
