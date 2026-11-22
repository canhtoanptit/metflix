import type { ServiceDependencies } from "../../services/context.ts";
import { type AreaModule, type AreaSeams, NO_JOBS } from "../module.ts";

/**
 * The personalisation area (milestone 2 §7.2): the importer job that fills
 * `deps.recommendations` from the pipeline's artefacts, candidates and scores for the engine
 * (recommendations/engine.ts stays the authority for every rule), session re-ranking from the
 * neighbours table, and editorial data (billboards, curated collections, availability) the
 * admin console edits. Milestone 1's browse, search and engine are this area's too.
 */
export interface PersonalisationService extends AreaModule {}

export function createPersonalisationService(
  _deps: ServiceDependencies,
  _seams: AreaSeams,
): PersonalisationService {
  return { ...NO_JOBS };
}
