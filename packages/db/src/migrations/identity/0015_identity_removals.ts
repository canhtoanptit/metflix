import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Identity area: issuer identities removed from an account (docs/BLUEPRINT-M2.md §4.1). A member
 * who unlinks an identity, or a password reset that drops one linked under another address, must
 * not see it come back through the automatic link of §4.1 on its next sign-in: a removed identity
 * is linked again only deliberately (from Account, with a fresh proof). Keyed by the identity
 * (provider, subject); deleted with the account.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema
    .createTable("identity_removals")
    .addColumn("provider", t.text, (c) => c.notNull())
    .addColumn("subject", t.text, (c) => c.notNull())
    .addColumn("account_id", t.text, (c) =>
      c.notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("reason", t.text, (c) => c.notNull())
    .addColumn("removed_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("identity_removals_pkey", ["provider", "subject"])
    .execute();
  await db.schema
    .createIndex("identity_removals_account_idx")
    .on("identity_removals")
    .column("account_id")
    .execute();
}
