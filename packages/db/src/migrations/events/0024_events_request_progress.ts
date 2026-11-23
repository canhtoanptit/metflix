import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Milestone 2, events area, the privacy review's fixes: an erasure is retried until it finishes
 * (`started_at`: when it first started; `attempts`; `retry_at`: when the sweep runs it again,
 * also the lease of a run in progress), and what a request's email did (`email_status`:
 * `pending`, `sent` or `suppressed`). Nullable ADD COLUMN only.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema.alterTable("privacy_requests").addColumn("started_at", t.time).execute();
  await db.schema.alterTable("privacy_requests").addColumn("attempts", t.int).execute();
  await db.schema.alterTable("privacy_requests").addColumn("retry_at", t.time).execute();
  await db.schema.alterTable("privacy_requests").addColumn("email_status", t.text).execute();
  await db.schema
    .createIndex("privacy_requests_retry_idx")
    .on("privacy_requests")
    .columns(["status", "retry_at"])
    .execute();
}
