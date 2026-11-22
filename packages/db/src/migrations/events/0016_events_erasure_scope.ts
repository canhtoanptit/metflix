import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Milestone 2, events area: which account erasure a profile's erasure record belongs to. A
 * profile record of an account deletion carries its account's key (the pipeline discovers the
 * account's profiles itself, so only the account key is listed, and confirming it settles the
 * profile records); a profile erased on its own (it became restricted) has none and is listed.
 * Nullable ADD COLUMN only.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema.alterTable("privacy_erasures").addColumn("account_key", t.text).execute();
  await db.schema
    .createIndex("privacy_erasures_account_key_idx")
    .on("privacy_erasures")
    .column("account_key")
    .execute();
}
