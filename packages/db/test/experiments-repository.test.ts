/**
 * The experiments repository on every Node dialect, with its audit rows read back from
 * `audit_log` (the generic area runner in areas.test.ts cannot see them).
 */
import { describeExperimentsRepositoryContract } from "@webflix/core/testing";
import { describe } from "vitest";
import type { Database } from "../src/database.ts";
import { createRepositories } from "../src/repositories/index.ts";
import { dialectHarnesses } from "./harness.ts";

export async function auditRows(database: Database) {
  const rows = await database.db.selectFrom("audit_log").selectAll().orderBy("id").execute();
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    target: { type: row.target_type, id: row.target_id },
    reason: row.reason,
  }));
}

for (const harness of dialectHarnesses) {
  describe.skipIf(harness.skip)(harness.label, () => {
    describeExperimentsRepositoryContract(`${harness.name} with audit rows`, async () => {
      const { database, cleanup } = await harness.create();
      return { repos: createRepositories(database), auditRows: () => auditRows(database), cleanup };
    });
  });
}
