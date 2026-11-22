import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Per-profile lists keyed by run (docs/RECOMMENDATIONS.md, "Learned candidates"): importing a
 * model is a publish, so the new run's lists are written beside the served run's and become
 * visible with the run's activation, and rolling back finds the previous run's lists intact.
 * `recommendation_profiles` (one row per profile, last write wins) cannot do either and stays
 * unused; it is not dropped (no table is dropped or rebuilt, docs/FOUNDATION.md §8.4).
 *
 * `recommendation_models.finished_at`: when the run's import completed (the staff console's
 * "last import"), which `activated_at` cannot tell once a rollback re-activates a run.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);

  // 4 bound parameters per row: 25 rows per INSERT under the 100-parameter limit.
  await db.schema
    .createTable("recommendation_profile_lists")
    .addColumn("model_version", t.text, (c) => c.notNull())
    .addColumn("profile_key", t.text, (c) => c.notNull())
    .addColumn("payload", t.text, (c) => c.notNull())
    .addColumn("expires_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("recommendation_profile_lists_pkey", ["model_version", "profile_key"])
    .execute();

  await db.schema.alterTable("recommendation_models").addColumn("finished_at", t.time).execute();
}
