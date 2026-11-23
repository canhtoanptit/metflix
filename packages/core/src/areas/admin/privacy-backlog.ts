/**
 * Whether privacy work is being done (review finding M2): pending erasures and data exports
 * waiting for the pipeline, counted with the age of the oldest, for `GET /system/health`.
 *
 * All of it from the events area's service (`staff.privacyBacklog`): pending erasures, exports
 * waiting for the pipeline, and account erasures started and not finished (one stuck shows as
 * `erasuresInProgress` with a growing age). Read-only; no key leaves the events area.
 */
import type { SystemHealth } from "@webflix/contracts";
import { toIsoString } from "../../ports/clock.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import type { AreaServices } from "../index.ts";

/** Counted up to this many each (the oldest is what matters). */
export const PRIVACY_BACKLOG_LIMIT = 500;

export async function privacyBacklog(
  deps: ServiceDependencies,
  areas: () => AreaServices,
): Promise<SystemHealth["privacy"]> {
  const now = deps.clock.now();
  const backlog = await areas().events.staff.privacyBacklog(PRIVACY_BACKLOG_LIMIT);
  const at = (value: number | null) => (value === null ? null : toIsoString(value));
  const age = (value: number | null) =>
    value === null ? null : Math.max(0, Math.floor((now - value) / 1000));
  return {
    pendingErasures: backlog.pendingErasures.count,
    oldestPendingErasureAt: at(backlog.pendingErasures.oldestAt),
    oldestPendingErasureAgeSec: age(backlog.pendingErasures.oldestAt),
    waitingExports: backlog.waitingExports.count,
    oldestWaitingExportAt: at(backlog.waitingExports.oldestAt),
    oldestWaitingExportAgeSec: age(backlog.waitingExports.oldestAt),
    erasuresInProgress: backlog.erasuresInProgress.count,
    oldestErasureInProgressAt: at(backlog.erasuresInProgress.oldestAt),
    oldestErasureInProgressAgeSec: age(backlog.erasuresInProgress.oldestAt),
  };
}
