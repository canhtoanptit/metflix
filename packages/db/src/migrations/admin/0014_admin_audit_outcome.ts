import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Milestone 2, admin area: the outcome of an audited staff action, and the console's
 * idempotency key.
 *
 * The identity, billing and events services do not write the audit log themselves, so the staff
 * API writes their entry *before* it calls them (`pending`, with who, what, on whom and why) and
 * settles it afterwards (`succeeded`, `failed` or `unknown`): no such action can be observed
 * without its entry. Entries the experiments and personalisation repositories write in the same
 * batch as their change are complete when written, hence the column's default `succeeded`
 * (nullable, as every added column must be: §8.4; the repository reads a null as `succeeded`).
 *
 * `idempotency_key` is unique (several NULLs are allowed on every dialect): a retried request
 * with the same key finds the entry of the first one instead of acting twice.
 *
 * ADD COLUMN and indexes only: the table is not rebuilt.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema
    .alterTable("audit_log")
    .addColumn("outcome", t.text, (c) => c.defaultTo("succeeded"))
    .execute();
  await db.schema.alterTable("audit_log").addColumn("completed_at", t.time).execute();
  await db.schema.alterTable("audit_log").addColumn("idempotency_key", t.text).execute();
  await db.schema
    .createIndex("audit_log_idempotency_key_idx")
    .on("audit_log")
    .column("idempotency_key")
    .unique()
    .execute();
  await db.schema
    .createIndex("audit_log_outcome_idx")
    .on("audit_log")
    .columns(["outcome", "created_at"])
    .execute();
}
