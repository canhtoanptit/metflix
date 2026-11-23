import { ApiError } from "@webflix/contracts";
import { useEffect, useState } from "react";

/**
 * A refusal for asking too often (`rate_limited`, UX review: rate limits never strand a member):
 * the seconds left before trying again is worth it, counted down, 0 once it is (or for any other
 * error). `since` is when the refusal arrived, so a re-render never restarts the count.
 */
export function useRetryAfter(error: unknown, since: number | null): number {
  const retryAfterSec = ApiError.is(error, "rate_limited") ? error.problem.retryAfterSec : 0;
  const until = since !== null && retryAfterSec > 0 ? since + retryAfterSec * 1000 : 0;
  const left = () => Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    setSeconds(left());
    if (!until) return;
    const timer = window.setInterval(() => {
      const next = left();
      setSeconds(next);
      if (next === 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  return seconds;
}

/** "Too many attempts just now. Try again in 20 seconds." */
export function describeTooMany(error: unknown, what: "codes" | "attempts"): string | null {
  if (!ApiError.is(error, "rate_limited")) return null;
  const seconds = error.problem.retryAfterSec;
  const wait = `Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
  return what === "codes" ? `Too many codes tried. ${wait}` : `Too many attempts just now. ${wait}`;
}
