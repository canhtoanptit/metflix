import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Billing area: the membership's next invoice as the provider previews it (when and how much),
 * kept with the projection so every read of the membership can show it without asking the
 * provider. JSON `{ at, amountMinor, currency }`, or null (none, or not computed yet: the next
 * write computes it). Nullable, like every column added to an existing table (D-M2-5).
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema.alterTable("memberships").addColumn("next_invoice_json", t.text).execute();
}
