/**
 * Drops the per-test Postgres schemas (`t_*`) before and after a run, never during it: Kysely's
 * migrator introspects every schema of the database (`has_schema_privilege` per schema), so a
 * schema dropped by one test file while another file migrates makes that migration fail with
 * "schema does not exist". The disposable container of `test:postgres` makes this mostly moot;
 * it matters when WEBFLIX_TEST_POSTGRES_URL points at a longer-lived database.
 */
import pg from "pg";

async function dropTestSchemas(): Promise<void> {
  const url = process.env.WEBFLIX_TEST_POSTGRES_URL;
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname LIKE 't\\_%'",
    );
    for (const { nspname } of rows) {
      await client.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
    }
  } finally {
    await client.end();
  }
}

export async function setup(): Promise<void> {
  await dropTestSchemas();
}

export async function teardown(): Promise<void> {
  await dropTestSchemas();
}
