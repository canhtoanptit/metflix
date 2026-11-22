import { type Kysely, sql } from "kysely";
import type { SqlDialect } from "../../dialect.ts";

/**
 * Milestone 2, events area (docs/BLUEPRINT-M2.md §6.3): at most one open privacy request per
 * account and kind. The repository inserts only while none is open (one statement); this
 * partial unique index settles two concurrent inserts (Postgres READ COMMITTED lets both pass
 * the NOT EXISTS). SQLite, D1 and PostgreSQL all support partial indexes.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, _dialect: SqlDialect): Promise<void> {
  await db.schema
    .createIndex("privacy_requests_open_idx")
    .on("privacy_requests")
    .columns(["account_id", "kind"])
    .unique()
    .where(sql.ref("status"), "in", [
      sql.lit("pending"),
      sql.lit("scheduled"),
      sql.lit("processing"),
    ])
    .execute();
}
