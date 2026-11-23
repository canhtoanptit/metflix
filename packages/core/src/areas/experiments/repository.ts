import type { ExperimentDefinition, JsonValue } from "@webflix/contracts";
import type { AuditRecord } from "./audit.ts";

/**
 * Repository port of the experiments area: `experiments` (pre-registered definitions, with an
 * optimistic `version`) and `experiment_results` (the analysis job's reports); migrations under
 * `packages/db/src/migrations/experiments/`. Staff changes write their `audit_log` row in the
 * same batch (`AuditRecord`).
 *
 * Implemented in memory by `packages/core/src/memory/areas/experiments.ts` and on every dialect
 * by `packages/db/src/repositories/areas/experiments.ts`; both pass
 * `describeExperimentsRepositoryContract` (`packages/core/src/testing/areas/experiments.contract.ts`).
 * The D1 rules hold: one batch per write, at most 100 bound parameters per statement.
 */
export interface ExperimentsRepository {
  /** Every definition, by key. */
  listExperiments(): Promise<StoredExperiment[]>;
  getExperiment(key: string): Promise<StoredExperiment | null>;
  /** Inserts a definition at version 1 with its audit row; false (nothing written) if the key exists. */
  createExperiment(definition: ExperimentDefinition, audit: AuditRecord): Promise<boolean>;
  /**
   * Replaces the definition stored at `expectedVersion` (it becomes `expectedVersion + 1`) with
   * its audit row; false (nothing written) when another change got there first.
   */
  updateExperiment(
    definition: ExperimentDefinition,
    expectedVersion: number,
    audit: AuditRecord,
  ): Promise<boolean>;
  /** The newest analysis report of an experiment, or null. */
  latestResults(key: string): Promise<ExperimentReport | null>;
  /** Stores a report (the analysis job's import); the same `computedAt` again replaces it. */
  saveResults(key: string, report: ExperimentReport): Promise<void>;
  /**
   * Retention (the aggregates period): deletes reports computed before `before` (epoch ms),
   * oldest first, at most `limit` (bounded statements); returns how many went.
   */
  pruneResults(before: number, limit: number): Promise<number>;
}

export interface StoredExperiment {
  definition: ExperimentDefinition;
  version: number;
}

export interface ExperimentReport {
  computedAt: number;
  report: JsonValue;
}
