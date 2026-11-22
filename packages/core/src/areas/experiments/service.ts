import type { ExperimentAssignments } from "@webflix/contracts";
import type { AssignmentContext, ExperimentUnit } from "../../ports/experiments.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import { type AreaModule, type AreaSeams, NO_JOBS } from "../module.ts";

/**
 * The experiments area (milestone 2 §8.1): definitions (through `deps.experiments` and the
 * experiments table), deterministic assignment (`assignVariants`), exposure logging through
 * `seams.emitServerEvent` when a treatment is experienced, and the analysis results the admin
 * console reads.
 */
export interface ExperimentsService extends AreaModule {
  /** The caller's assignments (`GET /session`; a ranking policy chosen per experiment). */
  assignments(unit: ExperimentUnit, context: AssignmentContext): Promise<ExperimentAssignments>;
}

export function createExperimentsService(
  deps: ServiceDependencies,
  _seams: AreaSeams,
): ExperimentsService {
  return {
    ...NO_JOBS,
    assignments: (unit, context) => deps.experiments.assign(unit, context, deps.clock.now()),
  };
}
