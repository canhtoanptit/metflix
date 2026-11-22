import { type Kysely, sql } from "kysely";
import type { SqlDialect } from "../../dialect.ts";

/**
 * Milestone 2, events area (custodian of milestone 1's playback): the playback sessions still
 * open, by their credit clock, for the sweep that ends a session nobody released (a killed tab)
 * and records its `playback.abandon` (`expired`). Partial, so it holds only open sessions. An
 * index only: the table is not rebuilt.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, _dialect: SqlDialect): Promise<void> {
  await db.schema
    .createIndex("playback_sessions_open_idx")
    .on("playback_sessions")
    .column("last_heartbeat_at")
    .where(sql.ref("ended_at"), "is", null)
    .execute();
}
