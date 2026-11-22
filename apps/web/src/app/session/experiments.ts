import type { ExperimentAssignments, SessionState } from "@webflix/contracts";
import { useSession } from "./session.ts";

/**
 * Experiment assignments (docs/BLUEPRINT-M2.md §8.1): `GET /session` says which variant of each
 * running experiment this profile (or, signed out, this device) is in. Assignment is the
 * server's, deterministic and sticky; the web never assigns.
 *
 * What the web does with them:
 * - every behaviour event carries them (the telemetry module adds them from the session);
 * - a page whose content depends on an assignment is cached per assignment
 *   (`assignmentKey`): a change of assignment never serves a page built under the old one;
 * - a client-side experiment reads its variant with `useExperimentVariant`:
 *
 *     const variant = useExperimentVariant("browse.row-artwork");  // "control" | "posters" | null
 *     return variant === "posters" ? <PosterRow … /> : <StandardRow … />;
 *
 *   null means "not in the experiment" (not running, not targeted, outside its allocation):
 *   render the default. Exposure is logged when the treatment is experienced, not when it is
 *   assigned, and `experiment.exposure` is a server event: a client-side experiment needs its
 *   server area to log exposure (as personalisation does for `recs.learned-vs-rules` when it
 *   serves a page), it cannot be sent from the browser.
 */

/** The session's assignments (empty when none, or signed out without any). */
export function assignmentsOf(session: SessionState | undefined): ExperimentAssignments {
  return session?.experiments ?? {};
}

/**
 * A stable string for a set of assignments (`key=variant,…`, sorted), for query keys: two
 * sessions with the same assignments share cached pages, any change of assignment does not.
 */
export function assignmentKey(assignments: ExperimentAssignments): string {
  return Object.entries(assignments)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, variant]) => `${key}=${variant}`)
    .join(",");
}

/** The current session's assignments as a query-key part (see `assignmentKey`). */
export function useAssignmentKey(): string {
  return assignmentKey(assignmentsOf(useSession()));
}

/** This session's variant of experiment `key`, or null when it is not in the experiment. */
export function useExperimentVariant(key: string): string | null {
  return assignmentsOf(useSession())[key] ?? null;
}
