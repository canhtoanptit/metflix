import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";
import type { Database } from "../database.ts";
import type { SqlDialect } from "../dialect.ts";
import * as initial from "./0001_initial.ts";
import { ADMIN_MIGRATIONS } from "./admin/index.ts";
import { BILLING_MIGRATIONS } from "./billing/index.ts";
import { EVENTS_MIGRATIONS } from "./events/index.ts";
import { EXPERIMENTS_MIGRATIONS } from "./experiments/index.ts";
import { IDENTITY_MIGRATIONS } from "./identity/index.ts";
import { PERSONALISATION_MIGRATIONS } from "./personalisation/index.ts";
import type { SchemaMigration } from "./types.ts";

export type { SchemaMigration } from "./types.ts";

/**
 * Every migration, oldest first (by name). Milestone 2's areas each list theirs in
 * `migrations/<area>/index.ts`, so areas add migrations without touching each other's files.
 * Append; never edit one that has shipped.
 */
export const MIGRATIONS: readonly SchemaMigration[] = [
  { name: "0001_initial", up: initial.up },
  ...IDENTITY_MIGRATIONS,
  ...BILLING_MIGRATIONS,
  ...EVENTS_MIGRATIONS,
  ...PERSONALISATION_MIGRATIONS,
  ...EXPERIMENTS_MIGRATIONS,
  ...ADMIN_MIGRATIONS,
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Kysely migration provider for a dialect (Node: SQLite and Postgres). */
export function migrationProvider(dialect: SqlDialect): MigrationProvider {
  return {
    async getMigrations() {
      const migrations: Record<string, Migration> = {};
      for (const migration of MIGRATIONS) {
        migrations[migration.name] = { up: (db) => migration.up(db, dialect) };
      }
      return migrations;
    },
  };
}

async function currentSchema(database: Database): Promise<string> {
  const result = await sql<{ schema: string }>`SELECT current_schema() AS schema`.execute(
    database.db,
  );
  const schema = result.rows[0]?.schema;
  if (!schema) throw new Error("Postgres has no current schema (empty search_path?)");
  return schema;
}

export interface MigrationOutcome {
  applied: string[];
  /**
   * Migrations the database has that this code does not know, all newer than every known one:
   * a newer release ran them and this (older) one is running again, e.g. after a rollback.
   * Accepted, because each release's schema changes stay backward compatible with the release
   * before; callers should warn loudly.
   */
  ahead: string[];
}

const MIGRATION_TABLE = "kysely_migration";

/** Names recorded in Kysely's bookkeeping table; empty when it does not exist yet. */
async function executedMigrations(database: Database, schema: string | null): Promise<string[]> {
  const exists = schema
    ? (
        await sql<{
          found: boolean;
        }>`SELECT to_regclass(${`${schema}.${MIGRATION_TABLE}`}) IS NOT NULL AS found`.execute(
          database.db,
        )
      ).rows[0]?.found
    : Number(
        (
          await sql<{
            n: number;
          }>`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATION_TABLE}`.execute(
            database.db,
          )
        ).rows[0]?.n ?? 0,
      ) > 0;
  if (!exists) return [];
  const { rows } = await sql<{ name: string }>`SELECT name FROM ${sql.table(
    schema ? `${schema}.${MIGRATION_TABLE}` : MIGRATION_TABLE,
  )}`.execute(database.db);
  return rows.map((row) => row.name);
}

/**
 * Executed migrations this code does not know. Accepted only when every known migration is
 * applied and every unknown one sorts after the last known (a newer release's); anything else
 * (another branch's migration, a gap in the middle) is a corrupt history and fails.
 */
function migrationsAhead(executed: readonly string[]): string[] {
  const known = new Set(MIGRATIONS.map((migration) => migration.name));
  const unknown = executed.filter((name) => !known.has(name)).sort();
  if (unknown.length === 0) return [];
  const lastKnown = MIGRATIONS.at(-1)?.name ?? "";
  const missing = MIGRATIONS.filter((migration) => !executed.includes(migration.name)).map(
    (migration) => migration.name,
  );
  const older = unknown.filter((name) => name <= lastKnown);
  if (missing.length > 0 || older.length > 0) {
    throw new Error(
      `The database's migration history does not fit this release: unknown ${unknown.join(", ")}` +
        (missing.length > 0 ? `; known but never applied ${missing.join(", ")}` : "") +
        (older.length > 0 ? `; not newer than ${lastKnown}: ${older.join(", ")}` : ""),
    );
  }
  return unknown;
}

/**
 * Apply pending migrations (SQLite, Postgres). Kysely's migrator takes a lock table, so
 * concurrent runs (several pods starting) are safe. D1 is migrated by
 * `wrangler d1 migrations apply` with the generated SQL files instead.
 */
export async function migrateToLatest(database: Database): Promise<MigrationOutcome> {
  if (database.dialect === "d1") {
    throw new Error(
      "D1 is migrated with `wrangler d1 migrations apply` (packages/db/migrations/d1).",
    );
  }
  const schema = database.dialect === "postgres" ? await currentSchema(database) : null;
  // A newer release already migrated this database (rollback): nothing to apply. Kysely itself
  // refuses ("corrupted migrations") whenever an executed migration is unknown.
  const ahead = migrationsAhead(await executedMigrations(database, schema));
  if (ahead.length > 0) return { applied: [], ahead };
  const migrator = new Migrator({
    db: database.db,
    provider: migrationProvider(database.dialect),
    // Kysely looks for its bookkeeping tables in every schema unless told which one; a second
    // schema with its own `kysely_migration_lock` (another app, a parallel test) would make it
    // skip creating ours. Pin them to the schema the connection actually writes to.
    ...(schema ? { migrationTableSchema: schema } : {}),
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    const failed = results?.find((result) => result.status === "Error")?.migrationName;
    throw new Error(`Migration ${failed ?? "(unknown)"} failed`, { cause: error });
  }
  return {
    applied: (results ?? [])
      .filter((result) => result.status === "Success")
      .map((result) => result.migrationName),
    ahead: [],
  };
}

// --- SQL generation (D1 migration files, schema diffs) -----------------------------------------

class RecordingConnection implements DatabaseConnection {
  readonly statements: CompiledQuery[] = [];

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    this.statements.push(compiledQuery);
    return { rows: [] };
  }

  // biome-ignore lint/correctness/useYield: never streams.
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("not supported");
  }
}

class RecordingDriver implements Driver {
  readonly connection = new RecordingConnection();
  async init() {}
  async acquireConnection() {
    return this.connection;
  }
  async beginTransaction() {}
  async commitTransaction() {}
  async rollbackTransaction() {}
  async releaseConnection() {}
  async destroy() {}
}

/**
 * The SQL statements a migration produces for a dialect, without a database: the migration
 * runs against a Kysely instance whose driver only records compiled statements.
 */
export async function compileMigration(
  migration: SchemaMigration,
  dialect: SqlDialect,
): Promise<string[]> {
  const driver = new RecordingDriver();
  const postgres = dialect === "postgres";
  // biome-ignore lint/suspicious/noExplicitAny: schema-only instance.
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => (postgres ? new PostgresAdapter() : new SqliteAdapter()),
      createDriver: () => driver,
      createQueryCompiler: () =>
        postgres ? new PostgresQueryCompiler() : new SqliteQueryCompiler(),
      createIntrospector: (instance) =>
        postgres ? new PostgresIntrospector(instance) : new SqliteIntrospector(instance),
    },
  });
  await migration.up(db, dialect);
  await db.destroy();
  return driver.connection.statements.map((statement) => {
    if (statement.parameters.length > 0) {
      throw new Error(`Migration ${migration.name} produced a parameterised statement`);
    }
    return statement.sql.trim();
  });
}

/** The content of `migrations/d1/<name>.sql` for one migration. */
export async function d1MigrationFile(migration: SchemaMigration): Promise<string> {
  const statements = await compileMigration(migration, "d1");
  return [
    `-- GENERATED from packages/db/src/migrations/${migration.source ?? `${migration.name}.ts`}. Do not edit.`,
    "-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.",
    "",
    ...statements.map((statement) => `${statement.replace(/\s+\n/g, "\n")};`),
    "",
  ].join("\n");
}
