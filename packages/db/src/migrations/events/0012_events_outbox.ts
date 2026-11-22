import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Milestone 2, events area (docs/BLUEPRINT-M2.md §6.1): the event outbox. Playback writes its
 * server events here in the same batch as the playback write that produced them (no extra
 * round trip on the request path); the events area's `events.outbox` job drains them to the
 * event lake and deletes them. No foreign key: a row of an erased account is dropped by the
 * drain (and by the erasure itself).
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema
    .createTable("event_outbox")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("account_id", t.text)
    .addColumn("profile_id", t.text)
    .addColumn("payload", t.text, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("event_outbox_created_idx")
    .on("event_outbox")
    .columns(["created_at", "id"])
    .execute();
  await db.schema
    .createIndex("event_outbox_account_idx")
    .on("event_outbox")
    .column("account_id")
    .execute();
}
