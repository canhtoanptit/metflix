import type { PersonalisationRepository } from "@webflix/core";
import type { Database } from "../../database.ts";

/**
 * The personalisation area's repository on every dialect (SQLite, PostgreSQL, D1), over its tables
 * (`tables/personalisation.ts`). Empty until the personalisation owner adds methods; each must pass
 * `describePersonalisationRepositoryContract` here and in workerd.
 */
export function createPersonalisationRepository(_database: Database): PersonalisationRepository {
  return {};
}
