import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * A status change takes effect for assignment at one instant everywhere (docs/KUBERNETES.md
 * §9.11, finding K4): replicas and isolates cache the definitions, so a change made now would
 * reach them at different moments and a unit's assignment would flip between requests. Until
 * `status_change_at`, assignment follows `previous_status`. Both nullable (no table rebuild).
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema.alterTable("experiments").addColumn("previous_status", t.text).execute();
  await db.schema.alterTable("experiments").addColumn("status_change_at", t.time).execute();
}
