import type { ExperimentsRepository } from "@webflix/core";
import type { Database } from "../../database.ts";

/**
 * The experiments area's repository on every dialect (SQLite, PostgreSQL, D1), over its tables
 * (`tables/experiments.ts`). Empty until the experiments owner adds methods; each must pass
 * `describeExperimentsRepositoryContract` here and in workerd.
 */
export function createExperimentsRepository(_database: Database): ExperimentsRepository {
  return {};
}
