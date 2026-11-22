import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Milestone 2, admin area (docs/BLUEPRINT-M2.md §8.3): the audit log, written by every area's
 * repository in the same batch as the change it records, and dead-lettered jobs for replay.
 * No foreign keys: an audit entry outlives whatever it is about.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);

  await db.schema
    .createTable("audit_log")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("actor_type", t.text, (c) => c.notNull())
    .addColumn("actor_id", t.text, (c) => c.notNull())
    .addColumn("actor_name", t.text)
    .addColumn("action", t.text, (c) => c.notNull())
    .addColumn("target_type", t.text, (c) => c.notNull())
    .addColumn("target_id", t.text, (c) => c.notNull())
    .addColumn("before_json", t.text)
    .addColumn("after_json", t.text)
    .addColumn("reason", t.text)
    .addColumn("request_id", t.text)
    .addColumn("created_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("audit_log_created_idx")
    .on("audit_log")
    .column("created_at")
    .execute();
  await db.schema
    .createIndex("audit_log_target_idx")
    .on("audit_log")
    .columns(["target_type", "target_id", "created_at"])
    .execute();
  await db.schema
    .createIndex("audit_log_actor_idx")
    .on("audit_log")
    .columns(["actor_id", "created_at"])
    .execute();

  await db.schema
    .createTable("job_dead_letters")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("job_type", t.text, (c) => c.notNull())
    .addColumn("payload_json", t.text, (c) => c.notNull())
    .addColumn("attempts", t.int, (c) => c.notNull())
    .addColumn("last_error", t.text)
    .addColumn("failed_at", t.time, (c) => c.notNull())
    .addColumn("replayed_at", t.time)
    .execute();
  await db.schema
    .createIndex("job_dead_letters_failed_idx")
    .on("job_dead_letters")
    .column("failed_at")
    .execute();
}
