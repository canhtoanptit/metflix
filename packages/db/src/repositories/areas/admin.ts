import type { AdminRepository } from "@webflix/core";
import type { Database } from "../../database.ts";

/**
 * The admin area's repository on every dialect (SQLite, PostgreSQL, D1), over its tables
 * (`tables/admin.ts`). Empty until the admin owner adds methods; each must pass
 * `describeAdminRepositoryContract` here and in workerd.
 */
export function createAdminRepository(_database: Database): AdminRepository {
  return {};
}
