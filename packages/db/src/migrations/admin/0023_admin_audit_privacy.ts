import { type Kysely, sql } from "kysely";
import type { SqlDialect } from "../../dialect.ts";

/**
 * Milestone 2, admin area (privacy review M5): what earlier code wrote to the audit log and must
 * not keep. A member search now records the query's shape only (`j***@e***`), never the address
 * typed; the existing entries keep their first character. An erasure confirmation now records how
 * many keys were confirmed, never which; the existing entries lose their key list (`after` keeps
 * the count). Data only: no column or table changes.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, _dialect: SqlDialect): Promise<void> {
  // Literal statements (no bound parameters), so the generated D1 file is plain SQL.
  await sql
    .raw(
      `update "audit_log" set "target_id" = substr("target_id", 1, 1) || '***' where "action" = 'member.searched' and "target_id" not like '%***'`,
    )
    .execute(db);
  await sql
    .raw(
      `update "audit_log" set "before_json" = null where "action" = 'privacy.erasures_confirmed'`,
    )
    .execute(db);
}
