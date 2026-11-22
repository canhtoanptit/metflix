/**
 * The Cron Trigger for the local dev server. `wrangler dev` never fires Cron Triggers on its own
 * (it only exposes `/cdn-cgi/handler/scheduled` with `--test-scheduled`; observed with 4.166),
 * so without this nothing would run the periodic jobs locally: the playback outbox would never
 * drain into the lake, due erasures and billing reconciliation would never run. The Node dev
 * mode has its in-process timer for the same reason. This fires the Worker's own `scheduled()`
 * on the schedule wrangler.jsonc declares, at the same UTC minute boundaries the platform uses.
 */

/** N of a `*\/N * * * *` expression (every N minutes), or null for anything else. */
export function everyMinutes(cron: string): number | null {
  const match = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(cron.trim());
  if (!match) return cron.trim() === "* * * * *" ? 1 : null;
  const minutes = Number(match[1]);
  return minutes >= 1 && minutes <= 59 && 60 % minutes === 0 ? minutes : null;
}

/** Milliseconds from `now` to the next UTC minute that is a multiple of `minutes`. */
export function untilNextFiring(now: number, minutes: number): number {
  const period = minutes * 60_000;
  return period - (now % period);
}

export interface LocalCronOptions {
  port: number;
  crons: readonly string[];
  /**
   * Fire every this many seconds instead of on the schedule (conformance runs: the suite's
   * erasure check needs a tick of 30 s or less, finer than a Cron Trigger can be).
   */
  everySec?: number;
  log: (message: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Starts the ticker; returns a function that stops it. */
export function startLocalCron(options: LocalCronOptions): () => void {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;
  for (const cron of options.crons) {
    const minutes = everyMinutes(cron);
    if (minutes === null && !options.everySec) {
      options.log(
        `local cron: "${cron}" is not an every-N-minutes schedule; run it with make cf-cron`,
      );
      continue;
    }
    const fire = async () => {
      const url = `http://localhost:${options.port}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(cron)}`;
      try {
        const response = await doFetch(url);
        await response.arrayBuffer();
        if (!response.ok) options.log(`local cron: ${cron} answered ${response.status}`);
      } catch (error) {
        options.log(`local cron: ${cron} not delivered (${(error as Error).message})`);
      }
    };
    const delay = () =>
      options.everySec ? options.everySec * 1000 : untilNextFiring(now(), minutes ?? 1);
    const schedule = () => {
      if (stopped) return;
      const timer = setTimeout(() => {
        void fire();
        schedule();
      }, delay());
      timers.set(cron, timer);
    };
    schedule();
    options.log(
      options.everySec
        ? `local cron: firing "${cron}" every ${options.everySec} s (CF_CRON_EVERY; the platform cannot go below a minute)`
        : `local cron: firing "${cron}" every ${minutes} min (UTC), as the platform would`,
    );
  }
  return () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
