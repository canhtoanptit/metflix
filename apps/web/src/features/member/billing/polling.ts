import { useLatest } from "@webflix/ui";
import { useEffect, useState } from "react";
import { isRetryableError } from "../../../app/query/errors.ts";

/**
 * The server's billing state moves on its own (the provider's events), so screens that wait on
 * it ask again until it settles. "Still processing" and a retryable failure (a 503 while the
 * provider is busy, a dropped connection) are ordinary answers: the next ask usually settles it.
 */

/** Pause before the nth ask (1-based): quick at first, then every few seconds. */
export function pollDelayMs(attempt: number): number {
  const steps = [1_000, 1_000, 1_500, 2_000, 3_000];
  return steps[attempt - 1] ?? 5_000;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Send a request again while it answers a retryable failure, a few times with backoff. A
 * refusal (4xx) is never retried: it is the answer.
 */
export async function patiently<T>(send: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= attempts || !isRetryableError(error)) throw error;
      await sleep(pollDelayMs(attempt) * 1.5);
    }
  }
}

export interface PollState<T> {
  /** The latest answer. */
  value: T | null;
  /** The last ask failed in a retryable way (asking again). */
  troubled: boolean;
  /** A refusal that ends the polling (e.g. `not_found`). */
  error: unknown;
  /** When polling started (ms since epoch), for "this is taking longer than usual". */
  startedAt: number;
  /** Asks made so far. */
  attempts: number;
}

/**
 * Ask `fetch` repeatedly while `active`, until `settled(value)` is true or the server refuses.
 * Asks again at once when the page becomes visible (a member back from another tab).
 */
export function usePoll<T>(
  key: string,
  fetch: () => Promise<T>,
  options: { active: boolean; settled: (value: T) => boolean },
): PollState<T> {
  const [state, setState] = useState<PollState<T>>(() => ({
    value: null,
    troubled: false,
    error: null,
    startedAt: Date.now(),
    attempts: 0,
  }));
  const latestFetch = useLatest(fetch);
  const latestSettled = useLatest(options.settled);

  useEffect(() => {
    if (!options.active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let inFlight = false;
    // A fresh start forgets the last answer: it may belong to a state the page has left.
    setState({ value: null, troubled: false, error: null, startedAt: Date.now(), attempts: 0 });

    const ask = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      clearTimeout(timer);
      attempt += 1;
      let done = false;
      try {
        const value = await latestFetch.current();
        if (stopped) return;
        done = latestSettled.current(value);
        setState((current) => ({ ...current, value, troubled: false, attempts: attempt }));
      } catch (error) {
        if (stopped) return;
        if (!isRetryableError(error)) {
          done = true;
          setState((current) => ({ ...current, error, attempts: attempt }));
        } else {
          setState((current) => ({ ...current, troubled: true, attempts: attempt }));
        }
      } finally {
        inFlight = false;
      }
      if (!done && !stopped) timer = setTimeout(() => void ask(), pollDelayMs(attempt));
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void ask();
    };
    document.addEventListener("visibilitychange", onVisible);
    void ask();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, options.active, latestFetch, latestSettled]);

  return state;
}
