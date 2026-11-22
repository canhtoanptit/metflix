import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Database } from "../src/database.ts";
import { migrateToLatest } from "../src/migrations/index.ts";
import { createPostgresDatabase, type PostgresOptions } from "../src/postgres.ts";
import { createSqliteDatabase } from "../src/sqlite.ts";

/**
 * Fresh, migrated databases for Node tests. SQLite always runs (in memory); Postgres runs when
 * `WEBFLIX_TEST_POSTGRES_URL` is set (`pnpm --filter @webflix/db test:postgres` starts a
 * container and sets it). Every harness is isolated: its own in-memory SQLite database or its
 * own Postgres schema, so test files can run in parallel against one server.
 */

export const postgresUrl = process.env.WEBFLIX_TEST_POSTGRES_URL ?? "";
export const postgresAvailable = postgresUrl !== "";

export interface DatabaseHarness {
  database: Database;
  cleanup(): Promise<void>;
}

export async function createSqliteHarness(): Promise<DatabaseHarness> {
  const database = createSqliteDatabase({ path: ":memory:" });
  await migrateToLatest(database);
  return { database, cleanup: () => database.close() };
}

async function adminQuery(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * A Postgres database confined to a new schema (dropped by the global setup/teardown). Pass a
 * unique `applicationName` to find (and terminate) this database's backends in
 * `pg_stat_activity` without touching other files' connections.
 */
export async function createPostgresHarness(
  options: Partial<
    Pick<PostgresOptions, "applicationName" | "maxConnections" | "onIdleConnectionError">
  > & {
    /**
     * `false`: leave the new schema empty (a test that migrates it with an older migration list).
     * Never drop a schema or its tables to get there: Kysely's migrator introspects every schema
     * of the server by name (`has_schema_privilege`, `pg_get_serial_sequence`), so an object
     * dropped while another test file migrates fails that file's migration.
     */
    migrate?: boolean;
  } = {},
): Promise<DatabaseHarness> {
  if (!postgresAvailable) throw new Error("WEBFLIX_TEST_POSTGRES_URL is not set");
  // Unquoted lowercase identifier: safe to interpolate, matches `search_path` without quoting.
  const schema = `t_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await adminQuery(`CREATE SCHEMA ${schema}`);
  const { migrate = true, ...poolOptions } = options;
  const database = createPostgresDatabase({
    connectionString: postgresUrl,
    schema,
    maxConnections: 2,
    applicationName: "webflix-db-test",
    ...poolOptions,
  });
  try {
    if (migrate) await migrateToLatest(database);
  } catch (error) {
    await database.close();
    throw error;
  }
  return {
    database,
    // The schema is left in place: dropping it while other files migrate races Kysely's schema
    // introspection. `postgres-global-setup.ts` drops every test schema before and after the run.
    cleanup: () => database.close(),
  };
}

export interface DialectHarness {
  name: "sqlite" | "postgres";
  /** Suite label; says why it is skipped when it is. */
  label: string;
  skip: boolean;
  create(): Promise<DatabaseHarness>;
}

/** Loop over these to run one suite against every Node-reachable dialect. */
export const dialectHarnesses: readonly DialectHarness[] = [
  { name: "sqlite", label: "sqlite (node:sqlite)", skip: false, create: createSqliteHarness },
  {
    name: "postgres",
    label: postgresAvailable
      ? "postgres"
      : "postgres (skipped: set WEBFLIX_TEST_POSTGRES_URL or run `pnpm --filter @webflix/db test:postgres`)",
    skip: !postgresAvailable,
    create: createPostgresHarness,
  },
];
