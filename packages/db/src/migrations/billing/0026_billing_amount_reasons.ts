import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Billing area: why an amount is below its price, as numbers (UX review 2.2, 2.3): the account
 * credit an invoice or a checkout's first payment uses, and its discount, so the member is told
 * "$7.99 less your $4.98 credit" rather than an unexplained $3.01. Nullable: rows from before
 * explain nothing, as before.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema.alterTable("invoices").addColumn("credit_applied_minor", t.int).execute();
  await db.schema.alterTable("invoices").addColumn("discount_minor", t.int).execute();
  await db.schema.alterTable("checkouts").addColumn("credit_applied_minor", t.int).execute();
  await db.schema.alterTable("checkouts").addColumn("discount_minor", t.int).execute();
}
