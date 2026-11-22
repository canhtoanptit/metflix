import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Identity area: single-use claims without a server session (docs/BLUEPRINT-M2.md §4.1). The
 * OpenID transaction lives in an encrypted cookie, so nothing on the server knows a callback was
 * already processed; a claim on the transaction id (insert-if-absent on the primary key) makes
 * the callback refuse the same authorisation response twice, on every dialect and across
 * replicas and isolates. Rows expire with the transaction and are deleted by the identity area's
 * periodic cleanup.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema
    .createTable("identity_claims")
    .addColumn("claim_key", t.text, (c) => c.primaryKey().notNull())
    .addColumn("expires_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("identity_claims_expires_idx")
    .on("identity_claims")
    .column("expires_at")
    .execute();
}
