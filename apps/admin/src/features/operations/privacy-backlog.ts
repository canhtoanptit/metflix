/**
 * The privacy work waiting (`SystemHealth.privacy`), and when it is worth a warning. Each line
 * has a normal wait, set by how often the work runs; a warning means that wait has clearly
 * passed, so the job doing it is not running or keeps failing:
 *
 * - **An account erasure in progress, over 15 minutes.** The product erases an account on the
 *   scheduler's tick (every 5 minutes) and retries a failure with backoff (1, 2, 4, 8… minutes).
 *   One still running after 15 minutes has failed three or four times: it keeps failing.
 * - **An erasure waiting for the event lake, over 30 hours.** The pipeline's erase job runs once
 *   a day (03:40, or every 24 hours in the serialised lake round) and may take up to an hour; 30
 *   hours means a daily run was missed or failed.
 * - **A data export waiting for events, over 2 hours.** The pipeline's export-events job runs
 *   every 5 minutes and waits for the hour's events to close (15 minutes' grace): about 80
 *   minutes at most. Past 2 hours nobody is processing exports, and each is given up after a day.
 *
 * Counts stop at 500 (the staff API counts up to there).
 */
import type { SystemHealth } from "@webflix/contracts";

export const PRIVACY_WARNING_AGE_SEC = {
  erasureInProgress: 15 * 60,
  pendingErasure: 30 * 3600,
  waitingExport: 2 * 3600,
} as const;

export const BACKLOG_COUNT_CAP = 500;

export interface BacklogLine {
  id: "erasures-in-progress" | "pending-erasures" | "waiting-exports";
  /** What waits, as a heading: "Account erasures in progress". */
  label: string;
  count: number;
  oldestAt: string | null;
  oldestAgeSec: number | null;
  /** The normal wait, in words, for the line's explanation. */
  normal: string;
  /** Past the normal wait: someone must look. */
  warning: boolean;
  /** What a warning means and where to look. */
  advice: string;
}

export function privacyBacklog(privacy: SystemHealth["privacy"]): BacklogLine[] {
  const late = (age: number | null, limit: number) => age !== null && age > limit;
  return [
    {
      id: "erasures-in-progress",
      label: "Account erasures in progress",
      count: privacy.erasuresInProgress,
      oldestAt: privacy.oldestErasureInProgressAt,
      oldestAgeSec: privacy.oldestErasureInProgressAgeSec,
      normal: "a few minutes",
      warning: late(
        privacy.oldestErasureInProgressAgeSec,
        PRIVACY_WARNING_AGE_SEC.erasureInProgress,
      ),
      advice:
        "An erasure has been retried for over 15 minutes: it keeps failing. The API's log says why (privacy.erasure_retry_scheduled, with the attempts and the last error). The member's account stays locked meanwhile.",
    },
    {
      id: "pending-erasures",
      label: "Erasures waiting for the event lake",
      count: privacy.pendingErasures,
      oldestAt: privacy.oldestPendingErasureAt,
      oldestAgeSec: privacy.oldestPendingErasureAgeSec,
      normal: "up to a day (the lake is erased daily)",
      warning: late(privacy.oldestPendingErasureAgeSec, PRIVACY_WARNING_AGE_SEC.pendingErasure),
      advice:
        "An erased member's events have waited over 30 hours to leave the event lake: the pipeline's daily erase job isn't running or keeps failing.",
    },
    {
      id: "waiting-exports",
      label: "Data exports waiting for events",
      count: privacy.waitingExports,
      oldestAt: privacy.oldestWaitingExportAt,
      oldestAgeSec: privacy.oldestWaitingExportAgeSec,
      normal: "up to about an hour and a half",
      warning: late(privacy.oldestWaitingExportAgeSec, PRIVACY_WARNING_AGE_SEC.waitingExport),
      advice:
        "A member's data export has waited over 2 hours for its events: nobody is processing exports (the pipeline's export-events job). Each is given up after a day.",
    },
  ];
}

/** "500+" at the cap. */
export function backlogCount(count: number): string {
  return count >= BACKLOG_COUNT_CAP ? `${BACKLOG_COUNT_CAP}+` : `${count}`;
}

/** An age in words: "40 s", "12 min", "3 h 20 min", "2 days 4 h". */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest > 0 ? `${days} days ${rest} h` : `${days} days`;
}
