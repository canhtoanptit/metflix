import { readdir, readFile } from "node:fs/promises";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { Database } from "../src/database.ts";
import { d1MigrationFile, MIGRATIONS, migrateToLatest } from "../src/migrations/index.ts";
import {
  createPostgresHarness,
  createSqliteHarness,
  dialectHarnesses,
  postgresAvailable,
} from "./harness.ts";

const d1Dir = new URL("../migrations/d1/", import.meta.url);

/** Pretend a release ran migration `name` (Kysely's bookkeeping table, current schema). */
async function recordMigration(database: Database, name: string): Promise<void> {
  await sql`INSERT INTO kysely_migration (name, timestamp) VALUES (${name}, ${new Date().toISOString()})`.execute(
    database.db,
  );
}

describe("generated D1 migration files", () => {
  it.each(MIGRATIONS.map((migration) => [migration.name, migration] as const))(
    "%s.sql matches its TypeScript source",
    async (name, migration) => {
      const onDisk = await readFile(new URL(`${name}.sql`, d1Dir), "utf8").catch(() => "");
      expect(
        onDisk,
        `migrations/d1/${name}.sql is stale or missing: run \`pnpm --filter @webflix/db generate\``,
      ).toBe(await d1MigrationFile(migration));
    },
  );

  it("has no SQL file without a TypeScript source", async () => {
    const files = (await readdir(d1Dir)).filter((file) => file.endsWith(".sql")).sort();
    expect(files).toEqual(MIGRATIONS.map((migration) => `${migration.name}.sql`));
  });
});

for (const harness of dialectHarnesses) {
  describe.skipIf(harness.skip)(`migrations on ${harness.label}`, () => {
    it("applies every migration once; running again is a no-op", async () => {
      const { database, cleanup } = await harness.create();
      try {
        // The harness already migrated: nothing left to apply.
        expect((await migrateToLatest(database)).applied).toEqual([]);
        expect((await migrateToLatest(database)).applied).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    // `helm rollback` runs the previous release's migrate against a schema a newer release
    // already moved forward: that must succeed (schemas are backward compatible by one
    // release), reporting what it does not know.
    it("succeeds when a newer release already applied migrations this one does not know", async () => {
      const { database, cleanup } = await harness.create();
      try {
        await recordMigration(database, "9999_added_by_newer_release");
        expect(await migrateToLatest(database)).toEqual({
          applied: [],
          ahead: ["9999_added_by_newer_release"],
        });
      } finally {
        await cleanup();
      }
    });

    it("still refuses an unknown migration that is not newer than every known one", async () => {
      const { database, cleanup } = await harness.create();
      try {
        await recordMigration(database, "0000_from_another_branch");
        await expect(migrateToLatest(database)).rejects.toThrow(/0000_from_another_branch/);
      } finally {
        await cleanup();
      }
    });

    it("still refuses newer migrations when a known one was never applied", async () => {
      const { database, cleanup } = await harness.create();
      try {
        const [first] = MIGRATIONS;
        if (!first) throw new Error("no migrations");
        await sql`DELETE FROM kysely_migration WHERE name = ${first.name}`.execute(database.db);
        await recordMigration(database, "9999_added_by_newer_release");
        await expect(migrateToLatest(database)).rejects.toThrow(/9999_added_by_newer_release/);
      } finally {
        await cleanup();
      }
    });
  });
}

type TypeFamily = "text" | "integer" | "real" | "other";

/** Physical types differ by name across dialects; what must match is the family. */
function typeFamily(dataType: string): TypeFamily {
  const type = dataType.toLowerCase();
  if (type === "text" || type === "varchar") return "text";
  if (["integer", "int", "int2", "int4", "int8", "bigint", "smallint"].includes(type)) {
    return "integer";
  }
  if (["real", "float4", "float8", "double precision"].includes(type)) return "real";
  return "other";
}

/** Engine-specific search structures that intentionally exist on one side only. */
const DIALECT_SPECIFIC_TABLE = /^search_fts(?:_|$)/;
const DIALECT_SPECIFIC_COLUMN = new Set(["search_documents.document"]);

async function describeSchema(database: Database, schema?: string) {
  const tables = await database.db.introspection.getTables();
  return tables
    .filter((table) => !table.isView)
    .filter((table) => schema === undefined || table.schema === schema)
    .filter((table) => !DIALECT_SPECIFIC_TABLE.test(table.name))
    .map((table) => ({
      table: table.name,
      columns: table.columns
        .filter((column) => !DIALECT_SPECIFIC_COLUMN.has(`${table.name}.${column.name}`))
        .map((column) => ({
          name: column.name,
          type: typeFamily(column.dataType),
          nullable: column.isNullable,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

describe.skipIf(!postgresAvailable)("schema equivalence (SQLite/D1 vs Postgres)", () => {
  it("has the same tables, columns, type families and nullability", async () => {
    const sqlite = await createSqliteHarness();
    const postgres = await createPostgresHarness();
    try {
      const pgSchema = (
        await postgres.database.db
          .selectNoFrom((eb) => eb.fn<string>("current_schema", []).as("schema"))
          .executeTakeFirstOrThrow()
      ).schema;
      const left = await describeSchema(sqlite.database);
      const right = await describeSchema(postgres.database, pgSchema);
      expect(left.length).toBeGreaterThan(20);
      expect(left.flatMap((table) => table.columns).some((c) => c.type === "other")).toBe(false);
      expect(right).toEqual(left);
    } finally {
      await sqlite.cleanup();
      await postgres.cleanup();
    }
  });
});
