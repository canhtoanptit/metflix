import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";

/**
 * Milestone 2, admin area: the audit log by request id. The staff console sends a request id of
 * its own with every call, so an unanswered request is matched to its entry
 * (`GET /audit?requestId=`, `GET /audit/mine?requestId=`). An index only: the table is not
 * rebuilt.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, _dialect: SqlDialect): Promise<void> {
  await db.schema
    .createIndex("audit_log_request_idx")
    .on("audit_log")
    .columns(["request_id", "created_at"])
    .execute();
}
