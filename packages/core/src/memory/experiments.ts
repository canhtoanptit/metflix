import type { ExperimentAssignments, ExperimentDefinition } from "@webflix/contracts";
import {
  type AssignmentContext,
  assignVariants,
  type Experiments,
  type ExperimentUnit,
} from "../ports/experiments.ts";

/** In-process `Experiments`: definitions held in memory (`set`), assignment by `assignVariants`. */
export class MemoryExperiments implements Experiments {
  private current: ExperimentDefinition[] = [];

  /** Replace every definition (tests; the admin API's writes go through the database). */
  set(definitions: readonly ExperimentDefinition[]): void {
    this.current = definitions.map((definition) => structuredClone(definition));
  }

  async definitions(): Promise<ExperimentDefinition[]> {
    return this.current.map((definition) => structuredClone(definition));
  }

  async assign(
    unit: ExperimentUnit,
    context: AssignmentContext,
    now: number,
  ): Promise<ExperimentAssignments> {
    return assignVariants(this.current, unit, context, now);
  }
}
