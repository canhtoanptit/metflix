import type { IdentityRepository } from "@webflix/core";
import type { Database } from "../../database.ts";

/**
 * The identity area's repository on every dialect (SQLite, PostgreSQL, D1), over its tables
 * (`tables/identity.ts`). Empty until the identity owner adds methods; each must pass
 * `describeIdentityRepositoryContract` here and in workerd.
 */
export function createIdentityRepository(_database: Database): IdentityRepository {
  return {};
}
