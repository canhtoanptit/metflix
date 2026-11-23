import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Identity area: `accounts.access_proven_at` (docs/BLUEPRINT-M2.md §4.1, security review H1).
 * When it was last established that every way in to the account (its password and its issuer
 * identities) was set up by someone who proved control of the account's current address: a
 * federated sign-up with an address the issuer verified, a completed password reset, or the
 * verification link opened in a session of the account. Automatic linking requires it, so a
 * verification click alone (which proves the click, not who set the password) never puts a
 * Google or Apple sign-in into an account someone else prepared. Cleared when the address
 * changes.
 *
 * Accounts that exist when this runs keep null (the safe default: nothing recorded says who set
 * up their ways in). They link deliberately, or a password reset proves them.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema.alterTable("accounts").addColumn("access_proven_at", t.time).execute();
}
