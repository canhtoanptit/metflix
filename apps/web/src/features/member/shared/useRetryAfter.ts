import { ApiError } from "@webflix/contracts";
import { useCallback, useEffect, useState } from "react";

/**
 * Seconds left until `until` (epoch ms), ticking once a second; 0 when no wait applies. Drives
 * the visible retry timers of rate-limited forms.
 */
export function useCountdown(until: number | null): number {
  const secondsLeft = useCallback(
    () => (until === null ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000))),
    [until],
  );
  const [state, setState] = useState(() => ({ until, remaining: secondsLeft() }));
  // A new deadline is reflected in the same render (never a stale 0 for one frame).
  let remaining = state.remaining;
  if (state.until !== until) {
    remaining = secondsLeft();
    setState({ until, remaining });
  }
  useEffect(() => {
    if (until === null) return;
    const timer = window.setInterval(() => {
      const next = secondsLeft();
      setState((current) => (current.remaining === next ? current : { until, remaining: next }));
      if (next === 0) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [until, secondsLeft]);
  return remaining;
}

/** When a request may be retried, from a `rate_limited` problem (null for any other error). */
export function retryAtFrom(error: unknown, now = Date.now()): number | null {
  if (!ApiError.is(error, "rate_limited")) return null;
  const seconds = Number.isFinite(error.problem.retryAfterSec) ? error.problem.retryAfterSec : 30;
  return now + seconds * 1000;
}

/**
 * Rate-limit state for one form: call `track(error)` from `onError`; `waiting` is the number of
 * seconds the member must still wait (the submit button stays disabled meanwhile).
 */
export function useRetryAfter() {
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const waiting = useCountdown(retryAt);
  const track = useCallback((error: unknown) => {
    const at = retryAtFrom(error);
    if (at !== null) setRetryAt(at);
  }, []);
  const clear = useCallback(() => setRetryAt(null), []);
  return { waiting, limited: retryAt !== null && waiting > 0, track, clear };
}
