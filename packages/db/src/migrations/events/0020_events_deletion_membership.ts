import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Milestone 2, events area: what an account deletion did to the membership. Scheduling a
 * deletion stops the renewals through billing's service (the membership ends at the close of
 * its period): `membership_step` is `stopping` until billing confirms (retried by the sweep),
 * then `ending` (with `membership_ends_at`, the period's close as billing reported it) or
 * `none` (no membership a provider renews). Null on exports and on deletions recorded before.
 * Nullable ADD COLUMN only.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);
  await db.schema.alterTable("privacy_requests").addColumn("membership_step", t.text).execute();
  await db.schema.alterTable("privacy_requests").addColumn("membership_ends_at", t.time).execute();
  await db.schema
    .createIndex("privacy_requests_membership_step_idx")
    .on("privacy_requests")
    .columns(["membership_step", "updated_at"])
    .execute();
}
