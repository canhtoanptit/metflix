import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Members who withdrew consent to personalisation (privacy review L1; docs/RECOMMENDATIONS.md,
 * "Privacy"): the account's pseudonymous key (serving gives its profiles the rule engine) and
 * its profiles' keys at the time (the importer stores no list for them), until the member
 * grants the purpose again or the account is erased. Keys only, like the lists.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);

  // 4 bound parameters per row: 25 rows per INSERT under the 100-parameter limit.
  await db.schema
    .createTable("recommendation_withdrawals")
    .addColumn("subject_key", t.text, (c) => c.primaryKey().notNull())
    .addColumn("account_key", t.text, (c) => c.notNull())
    .addColumn("kind", t.text, (c) => c.notNull())
    .addColumn("withdrawn_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("recommendation_withdrawals_account")
    .on("recommendation_withdrawals")
    .column("account_key")
    .execute();
}
