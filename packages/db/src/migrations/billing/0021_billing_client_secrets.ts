import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Billing area: the client secret the browser confirms a checkout's card or first payment with,
 * and a card change's, kept with the record (security review M1). A poll then answers from the
 * record instead of reading the provider every time: the provider is read only to learn whether
 * something changed, and at most once per account every couple of seconds. Nullable: rows from
 * before read the provider once, as they always did.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema.alterTable("checkouts").addColumn("client_secret", t.text).execute();
  await db.schema.alterTable("payment_method_setups").addColumn("client_secret", t.text).execute();
  // Why a card change failed, so a poll answers it without asking the provider again.
  await db.schema.alterTable("payment_method_setups").addColumn("failure_reason", t.text).execute();
}
