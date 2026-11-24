/**
 * The pool's minimum (`minConnections`): `warm()` opens it before a process takes traffic, the
 * pool keeps it however long it idles (only connections above it close), a burst is served from
 * it, and `warm()` refills it after the server cut connections. Runs with
 * WEBFLIX_TEST_POSTGRES_URL (`pnpm --filter @webflix/db test:postgres`).
 */

import { sql } from "kysely";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createPostgresDatabase } from "../src/postgres.ts";
import { postgresAvailable, postgresUrl } from "./harness.ts";

/** Connections the server sees from one pool (its application name). */
async function serverSide(applicationName: string): Promise<number> {
  const admin = new pg.Client({ connectionString: postgresUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_stat_activity WHERE application_name = $1",
      [applicationName],
    );
    return Number(rows[0]?.count ?? 0);
  } finally {
    await admin.end();
  }
}

async function terminate(applicationName: string): Promise<number> {
  const admin = new pg.Client({ connectionString: postgresUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
      [applicationName],
    );
    return rows.length;
  } finally {
    await admin.end();
  }
}

const name = () => `webflix-warm-test-${crypto.randomUUID().slice(0, 8)}`;

describe.skipIf(!postgresAvailable)("Postgres pool minimum", () => {
  it("opens the minimum on warm(), and a second warm() opens nothing", async () => {
    const applicationName = name();
    const database = createPostgresDatabase({
      connectionString: postgresUrl,
      applicationName,
      maxConnections: 6,
      minConnections: 3,
    });
    try {
      expect(database.poolStats?.()).toEqual({ total: 0, idle: 0, waiting: 0 });
      expect(await database.warm?.()).toEqual({ opened: 3, total: 3 });
      expect(database.poolStats?.()).toEqual({ total: 3, idle: 3, waiting: 0 });
      expect(await serverSide(applicationName)).toBe(3);
      expect(await database.warm?.()).toEqual({ opened: 0, total: 3 });
    } finally {
      await database.db.destroy();
    }
  });

  it("keeps the minimum however long it idles, and closes only what a burst added above it", async () => {
    const applicationName = name();
    const database = createPostgresDatabase({
      connectionString: postgresUrl,
      applicationName,
      maxConnections: 6,
      minConnections: 2,
      idleTimeoutMs: 200,
    });
    try {
      await database.warm?.();
      // A burst needs six at once: four more open.
      await Promise.all(
        Array.from({ length: 6 }, () => sql`SELECT pg_sleep(0.1)`.execute(database.db)),
      );
      expect(database.poolStats?.().total).toBe(6);
      // Idle well past the timeout: back to the minimum, never below it.
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(database.poolStats?.()).toEqual({ total: 2, idle: 2, waiting: 0 });
      expect(await serverSide(applicationName)).toBe(2);
    } finally {
      await database.db.destroy();
    }
  });

  it("serves a burst from the warm connections without opening any while they suffice", async () => {
    const applicationName = name();
    const database = createPostgresDatabase({
      connectionString: postgresUrl,
      applicationName,
      maxConnections: 10,
      minConnections: 4,
    });
    try {
      await database.warm?.();
      const opened: number[] = [];
      // Twenty quick statements, at most four at a time: the four warm connections serve all.
      for (let round = 0; round < 5; round += 1) {
        await Promise.all(Array.from({ length: 4 }, () => sql`SELECT 1`.execute(database.db)));
        opened.push(database.poolStats?.().total ?? -1);
      }
      expect(opened).toEqual([4, 4, 4, 4, 4]);
    } finally {
      await database.db.destroy();
    }
  });

  it("refills the minimum after the server cut its connections", async () => {
    const applicationName = name();
    const errors: Error[] = [];
    const database = createPostgresDatabase({
      connectionString: postgresUrl,
      applicationName,
      maxConnections: 6,
      minConnections: 3,
      onIdleConnectionError: (error) => errors.push(error),
    });
    try {
      await database.warm?.();
      expect(await terminate(applicationName)).toBe(3);
      await expect.poll(() => database.poolStats?.().total, { timeout: 5000 }).toBe(0);
      expect(await database.warm?.()).toEqual({ opened: 3, total: 3 });
      expect(await serverSide(applicationName)).toBe(3);
      const { rows } = await sql<{ one: number }>`SELECT 1 AS one`.execute(database.db);
      expect(rows).toEqual([{ one: 1 }]);
    } finally {
      await database.db.destroy();
    }
  });

  it("does not warm while requests wait for a connection, and says when it cannot connect", async () => {
    const applicationName = name();
    const busy = createPostgresDatabase({
      connectionString: postgresUrl,
      applicationName,
      maxConnections: 1,
      minConnections: 1,
    });
    try {
      // One connection, held by a slow statement, and a second statement waiting for it.
      const slow = sql`SELECT pg_sleep(0.3)`.execute(busy.db);
      const waiting = sql`SELECT 1`.execute(busy.db);
      await expect.poll(() => busy.poolStats?.().waiting, { timeout: 2000 }).toBe(1);
      expect(await busy.warm?.()).toEqual({ opened: 0, total: 1 });
      await Promise.all([slow, waiting]);
    } finally {
      await busy.db.destroy();
    }
    const unreachable = createPostgresDatabase({
      connectionString: "postgres://webflix:nothing@127.0.0.1:1/none",
      minConnections: 2,
      connectTimeoutMs: 500,
    });
    try {
      await expect(unreachable.warm?.()).rejects.toThrow();
    } finally {
      await unreachable.db.destroy();
    }
  });
});
