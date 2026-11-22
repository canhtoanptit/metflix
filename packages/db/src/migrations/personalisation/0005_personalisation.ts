import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Milestone 2, personalisation area (docs/BLUEPRINT-M2.md §7.2, §8.3): the imported
 * recommendation models (services/recs/README.md, "Loading it"), and editorial data staff
 * control. Editorial tables are separate from the catalogue's, which the seeder rewrites:
 * staff decisions survive a re-seed.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);

  await db.schema
    .createTable("recommendation_models")
    .addColumn("run", t.text, (c) => c.primaryKey().notNull())
    .addColumn("status", t.text, (c) => c.notNull())
    .addColumn("as_of", t.time, (c) => c.notNull())
    .addColumn("expires_at", t.time, (c) => c.notNull())
    .addColumn("imported_at", t.time, (c) => c.notNull())
    .addColumn("activated_at", t.time)
    .addColumn("manifest_sha256", t.text)
    .addColumn("error", t.text)
    .execute();

  // 6 bound parameters per row: 16 rows per INSERT under the 100-parameter limit.
  await db.schema
    .createTable("recommendation_neighbours")
    .addColumn("model_version", t.text, (c) => c.notNull())
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addColumn("rank", t.int, (c) => c.notNull())
    .addColumn("neighbour_id", t.text, (c) => c.notNull())
    .addColumn("score", t.real, (c) => c.notNull())
    .addColumn("support", t.int, (c) => c.notNull())
    .addPrimaryKeyConstraint("recommendation_neighbours_pkey", [
      "model_version",
      "title_id",
      "rank",
    ])
    .execute();

  // One row per profile, last write wins (SQLite and PostgreSQL; Workers KV on Cloudflare).
  await db.schema
    .createTable("recommendation_profiles")
    .addColumn("profile_key", t.text, (c) => c.primaryKey().notNull())
    .addColumn("model_version", t.text, (c) => c.notNull())
    .addColumn("payload", t.text, (c) => c.notNull())
    .addColumn("expires_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("recommendation_profiles_model_idx")
    .on("recommendation_profiles")
    .column("model_version")
    .execute();

  await db.schema
    .createTable("editorial_billboards")
    .addColumn("view", t.text, (c) => c.primaryKey().notNull())
    .addColumn("title_ids_json", t.text, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .addColumn("updated_by", t.text, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("editorial_collections")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("name", t.text, (c) => c.notNull())
    .addColumn("description", t.text)
    .addColumn("view", t.text, (c) => c.notNull())
    .addColumn("position", t.int, (c) => c.notNull())
    .addColumn("status", t.text, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .addColumn("updated_by", t.text, (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("editorial_collection_items")
    .addColumn("collection_id", t.text, (c) =>
      c.notNull().references("editorial_collections.id").onDelete("cascade"),
    )
    .addColumn("position", t.int, (c) => c.notNull())
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addPrimaryKeyConstraint("editorial_collection_items_pkey", ["collection_id", "position"])
    .execute();

  await db.schema
    .createTable("title_availability")
    .addColumn("title_id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("available", t.bool, (c) => c.notNull())
    .addColumn("available_from", t.time)
    .addColumn("available_until", t.time)
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .addColumn("updated_by", t.text, (c) => c.notNull())
    .execute();
}
