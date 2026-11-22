/** The personalisation (editorial) repository on D1 inside workerd, audit rows read back. */
import { describePersonalisationRepositoryContract } from "@webflix/core/testing";
import { createRepositories } from "../../src/repositories/index.ts";
import { freshD1Database } from "./setup.ts";

describePersonalisationRepositoryContract("d1 with audit rows", async () => {
  const database = await freshD1Database();
  return {
    repos: createRepositories(database),
    auditRows: async () =>
      (await database.db.selectFrom("audit_log").selectAll().orderBy("id").execute()).map(
        (row) => ({
          id: row.id,
          action: row.action,
          target: { type: row.target_type, id: row.target_id },
        }),
      ),
  };
});
