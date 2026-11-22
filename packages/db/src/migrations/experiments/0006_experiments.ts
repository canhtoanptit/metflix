import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Milestone 2, experiments area (docs/BLUEPRINT-M2.md §8.1): pre-registered definitions
 * (`ExperimentDefinition` in the contract) and the analysis job's reports.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);

  await db.schema
    .createTable("experiments")
    .addColumn("key", t.text, (c) => c.primaryKey().notNull())
    .addColumn("name", t.text, (c) => c.notNull())
    .addColumn("description", t.text)
    .addColumn("status", t.text, (c) => c.notNull())
    .addColumn("unit", t.text, (c) => c.notNull())
    .addColumn("layer", t.text, (c) => c.notNull())
    .addColumn("allocation_start", t.int, (c) => c.notNull())
    .addColumn("allocation_end", t.int, (c) => c.notNull())
    .addColumn("salt", t.text, (c) => c.notNull())
    .addColumn("targeting_json", t.text, (c) => c.notNull())
    .addColumn("variants_json", t.text, (c) => c.notNull())
    .addColumn("control", t.text, (c) => c.notNull())
    .addColumn("primary_metric", t.text, (c) => c.notNull())
    .addColumn("secondary_metrics_json", t.text, (c) => c.notNull())
    .addColumn("alpha", t.real, (c) => c.notNull())
    .addColumn("power", t.real)
    .addColumn("minimum_detectable_effect", t.real, (c) => c.notNull())
    .addColumn("srm_threshold", t.real)
    .addColumn("starts_at", t.time)
    .addColumn("ends_at", t.time)
    .addColumn("registered_at", t.time)
    .addColumn("version", t.int, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("experiments_status_idx")
    .on("experiments")
    .column("status")
    .execute();

  await db.schema
    .createTable("experiment_results")
    .addColumn("experiment_key", t.text, (c) => c.notNull())
    .addColumn("computed_at", t.time, (c) => c.notNull())
    .addColumn("report_json", t.text, (c) => c.notNull())
    .addPrimaryKeyConstraint("experiment_results_pkey", ["experiment_key", "computed_at"])
    .execute();
}
