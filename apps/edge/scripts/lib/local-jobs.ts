/**
 * The pipeline's privacy jobs on a timer, for a local deployment under test (`make cf-dev
 * CF_JOBS_EVERY=<seconds>`): what a scheduler runs beside a real account, here every few seconds
 * so that the conformance suite can request an export and see it complete. Its own loop, not the
 * Cron Trigger's: it runs outside the Worker (Python, the pipeline store), costs a process per
 * round, and must never delay or overlap a tick of the Worker's own `scheduled()`. One round at a
 * time: the next is scheduled when the previous one has finished. Off by default.
 */
export interface JobsLoopOptions {
  everySec: number;
  /** One round (spawns `ops.ts jobs run`); resolves when it is over. */
  round: () => Promise<void>;
  log: (message: string) => void;
}

export function startJobsLoop(options: JobsLoopOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await options.round();
      } catch (error) {
        options.log(`pipeline jobs: round failed (${(error as Error).message})`);
      }
      schedule();
    }, options.everySec * 1000);
  };
  schedule();
  options.log(
    `pipeline jobs: erase and export-events every ${options.everySec} s when something is pending (CF_JOBS_EVERY)`,
  );
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
