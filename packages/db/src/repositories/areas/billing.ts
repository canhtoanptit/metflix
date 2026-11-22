import type { BillingRepository } from "@webflix/core";
import type { Database } from "../../database.ts";

/**
 * The billing area's repository on every dialect (SQLite, PostgreSQL, D1), over its tables
 * (`tables/billing.ts`). Empty until the billing owner adds methods; each must pass
 * `describeBillingRepositoryContract` here and in workerd.
 */
export function createBillingRepository(_database: Database): BillingRepository {
  return {};
}
