/**
 * A graceful PostgreSQL shutdown (pod deletion, node drain, managed failover) sends
 * `FATAL 57P01 terminating connection due to administrator command` to every backend. A pooled
 * client that is lent out (between two statements, or with a statement in flight) must not turn
 * that into an unhandled 'error' event, which ends the process: the request fails (503 through
 * the repositories), the client is discarded, and the next request runs on a new connection.
 * A transaction cut mid-way leaves nothing behind. Runs with WEBFLIX_TEST_POSTGRES_URL
 * (`pnpm --filter @webflix/db test:postgres`).
 */
import { AppError } from "@webflix/core";
import { sql } from "kysely";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { isDatabaseUnavailable, withUnavailableErrors } from "../src/database.ts";
import { createRepositories } from "../src/repositories/index.ts";
import { createPostgresHarness, postgresAvailable, postgresUrl } from "./harness.ts";

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Backends of this pool, by state ("idle", "active", "idle in transaction"). */
function backends(applicationName: string, state?: string): Promise<number> {
  return admin(async (client) => {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND ($2::text IS NULL OR state = $2)",
      [applicationName, state ?? null],
    );
    return rows[0]?.n ?? 0;
  });
}

/** What a graceful shutdown does to each of them: `57P01` and a closed connection. */
function terminate(applicationName: string): Promise<number> {
  return admin(async (client) => {
    const { rows } = await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
      [applicationName],
    );
    return rows.length;
  });
}

describe.skipIf(!postgresAvailable)("Postgres connections terminated while lent", () => {
  it("survives clients terminated between two statements, and the pool recovers", async () => {
    const applicationName = `webflix-lent-${crypto.randomUUID().slice(0, 8)}`;
    const reported: Error[] = [];
    const { database, cleanup } = await createPostgresHarness({
      applicationName,
      maxConnections: 4,
      onIdleConnectionError: (error) => reported.push(error),
    });
    const repos = createRepositories(database);
    try {
      let resume = () => {};
      const terminated = new Promise<void>((resolve) => {
        resume = resolve;
      });
      // Four requests, each holding its connection idle between two statements.
      const lent = Array.from({ length: 4 }, () =>
        database.db.connection().execute(async (connection) => {
          await sql`SELECT 1`.execute(connection);
          await terminated;
          return sql`SELECT 1`.execute(connection).then(
            () => null,
            (error: unknown) => error,
          );
        }),
      );
      await expect.poll(() => backends(applicationName, "idle"), { timeout: 5000 }).toBe(4);
      expect(await terminate(applicationName)).toBe(4);
      // The termination reaches every client while it is lent and idle.
      await expect.poll(() => reported.length, { timeout: 5000 }).toBe(4);
      resume();
      const outcomes = await Promise.all(lent);
      expect(outcomes.every((outcome) => isDatabaseUnavailable(outcome))).toBe(true);
      // Discarded, not returned to the pool: the next requests open new connections.
      await repos.meta.set("after-termination", "ok", Date.now());
      expect(await repos.meta.get("after-termination")).toBe("ok");
      expect(reported).toHaveLength(4);
    } finally {
      await cleanup();
    }
  });

  it("fails a transaction cut mid-way cleanly, with nothing of it applied", async () => {
    const applicationName = `webflix-tx-${crypto.randomUUID().slice(0, 8)}`;
    const { database, cleanup } = await createPostgresHarness({ applicationName });
    const repos = createRepositories(database);
    const { db } = database;
    const write = (key: string) =>
      db.insertInto("meta").values({ key, value: "x", updated_at: Date.now() });
    try {
      // What every repository does with a batch: an outage is `service_unavailable`.
      const guarded = withUnavailableErrors({
        batch: () =>
          database.batch([
            write("mid-1"),
            db.selectNoFrom(sql<string>`pg_sleep(5)::text`.as("slept")),
            write("mid-2"),
          ]),
      });
      const cut = guarded.batch().then(
        () => null,
        (error: unknown) => error,
      );
      await expect.poll(() => backends(applicationName, "active"), { timeout: 5000 }).toBe(1);
      expect(await terminate(applicationName)).toBeGreaterThanOrEqual(1);
      const error = await cut;
      expect(AppError.is(error, "service_unavailable")).toBe(true);
      expect(isDatabaseUnavailable((error as AppError).cause)).toBe(true);
      // The server rolled the transaction back with the connection: no half of it remains.
      expect(await repos.meta.get("mid-1")).toBeNull();
      expect(await repos.meta.get("mid-2")).toBeNull();
      await database.batch([write("mid-3")]);
      expect(await repos.meta.get("mid-3")).toBe("x");
    } finally {
      await cleanup();
    }
  });
});
