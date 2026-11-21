/**
 * A PostgreSQL restart (or a cut connection) must not crash the process: idle pooled
 * connections that die are dropped and the next query reconnects. Runs with
 * WEBFLIX_TEST_POSTGRES_URL (`pnpm --filter @webflix/db test:postgres`).
 */

import { sql } from "kysely";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createPostgresDatabase } from "../src/postgres.ts";
import { postgresAvailable, postgresUrl } from "./harness.ts";

describe.skipIf(!postgresAvailable)("Postgres pool", () => {
  it("survives the server terminating its idle connections, and reconnects", async () => {
    const applicationName = `webflix-pool-test-${crypto.randomUUID().slice(0, 8)}`;
    const errors: Error[] = [];
    const database = createPostgresDatabase({
      connectionString: postgresUrl,
      applicationName,
      onIdleConnectionError: (error) => errors.push(error),
    });
    try {
      // Two idle connections in the pool.
      await Promise.all([
        sql`SELECT pg_sleep(0.05)`.execute(database.db),
        sql`SELECT pg_sleep(0.05)`.execute(database.db),
      ]);
      const admin = new pg.Client({ connectionString: postgresUrl });
      await admin.connect();
      try {
        const { rows } = await admin.query(
          "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name = $1",
          [applicationName],
        );
        expect(rows.length).toBe(2);
      } finally {
        await admin.end();
      }
      // The pool notices (an 'error' per idle client) without an unhandled error event.
      await expect.poll(() => errors.length, { timeout: 5000 }).toBe(2);
      const { rows } = await sql<{ one: number }>`SELECT 1 AS one`.execute(database.db);
      expect(rows).toEqual([{ one: 1 }]);
    } finally {
      await database.db.destroy();
    }
  });
});
