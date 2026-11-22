import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Milestone 2, events area (docs/BLUEPRINT-M2.md §6): consent, export and deletion requests,
 * the erasure list the lake compaction honours, and the daily aggregates batch jobs write back.
 * The events themselves live in the event lake (the blob store), never in the database.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);

  // §6.3: per account and purpose; the latest answer wins and the history is kept.
  await db.schema
    .createTable("consents")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("account_id", t.text, (c) =>
      c.notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("purpose", t.text, (c) => c.notNull())
    .addColumn("granted", t.bool, (c) => c.notNull())
    .addColumn("source", t.text, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("consents_account_idx")
    .on("consents")
    .columns(["account_id", "purpose", "created_at"])
    .execute();

  // §6.3: no foreign key: a completed deletion's record outlives the account it erased.
  await db.schema
    .createTable("privacy_requests")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("account_id", t.text, (c) => c.notNull())
    .addColumn("kind", t.text, (c) => c.notNull())
    .addColumn("status", t.text, (c) => c.notNull())
    .addColumn("requested_at", t.time, (c) => c.notNull())
    .addColumn("scheduled_for", t.time)
    .addColumn("completed_at", t.time)
    .addColumn("export_blob_key", t.text)
    .addColumn("expires_at", t.time)
    .addColumn("last_error", t.text)
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("privacy_requests_account_idx")
    .on("privacy_requests")
    .columns(["account_id", "kind", "requested_at"])
    .execute();
  await db.schema
    .createIndex("privacy_requests_due_idx")
    .on("privacy_requests")
    .columns(["status", "scheduled_for"])
    .execute();

  // §6.3: pseudonymous subject keys whose events the next compaction drops (the pipeline's
  // `compact --erase`); kept until compaction confirms.
  await db.schema
    .createTable("privacy_erasures")
    .addColumn("subject_key", t.text, (c) => c.primaryKey().notNull())
    .addColumn("kind", t.text, (c) => c.notNull())
    .addColumn("requested_at", t.time, (c) => c.notNull())
    .addColumn("compacted_at", t.time)
    .execute();

  // §6.2: aggregates computed over the lake by batch jobs, read by the admin console.
  await db.schema
    .createTable("analytics_daily")
    .addColumn("metric", t.text, (c) => c.notNull())
    .addColumn("day", t.text, (c) => c.notNull())
    .addColumn("dimension", t.text, (c) => c.notNull())
    .addColumn("value", t.real, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("analytics_daily_pkey", ["metric", "day", "dimension"])
    .execute();
}
