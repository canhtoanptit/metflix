/**
 * A heartbeat already in flight when the release (with the final position) commits must not
 * overwrite that position (docs/DECISIONS.md D17). On Postgres (READ COMMITTED) both batches
 * start by locking the session's row, so the later one sees the session ended and writes no
 * progress. SQLite and D1 serialise writers, so the order of the two batches decides alone.
 * Runs on Postgres with WEBFLIX_TEST_POSTGRES_URL (`pnpm --filter @webflix/db test:postgres`).
 */
import { sql } from "kysely";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { Database } from "../src/database.ts";
import { createRepositories } from "../src/repositories/index.ts";
import {
  createPostgresHarness,
  createSqliteHarness,
  postgresAvailable,
  postgresUrl,
} from "./harness.ts";

const NOW = 1_800_000_000_000;

async function withSession(database: Database) {
  const { db } = database;
  await db
    .insertInto("accounts")
    .values({
      id: "acc",
      email: "a@example.com",
      password_hash: "x",
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
  await db
    .insertInto("profiles")
    .values({
      id: "pro",
      account_id: "acc",
      name: "P",
      avatar_id: "av",
      is_kids: 0,
      maturity_ceiling: "18+",
      pin_hash: null,
      settings_json: "{}",
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
  const repos = createRepositories(database);
  await repos.playback.create({
    id: "ps1",
    accountId: "acc",
    profileId: "pro",
    sessionId: "s1",
    titleId: "t1",
    episodeId: null,
    assetId: null,
    maxVideoHeight: 1080,
    startedAt: NOW - 600_000,
    lastHeartbeatAt: NOW - 60_000,
    endedAt: null,
    positionSec: 400,
    durationSec: 5400,
    watchedSec: 0,
    state: "playing",
  });
  return repos;
}

const report = (positionSec: number, ends: boolean, historyId: string) => ({
  playbackSessionId: "ps1",
  profileId: "pro",
  titleId: "t1",
  episodeId: null,
  positionSec,
  durationSec: 5400,
  state: "playing" as const,
  completed: false,
  now: NOW,
  maxCreditSec: 90,
  historyId,
  ends,
});

async function progressOf(database: Database): Promise<number> {
  const row = await database.db
    .selectFrom("watch_progress")
    .select("position_sec")
    .where("profile_id", "=", "pro")
    .executeTakeFirstOrThrow();
  return Number(row.position_sec);
}

describe("a heartbeat racing the release", () => {
  it.runIf(postgresAvailable)(
    "postgres: an in-flight heartbeat leaves the release's final position alone",
    async () => {
      const { database, cleanup } = await createPostgresHarness();
      const release = new pg.Client({ connectionString: postgresUrl });
      try {
        const repos = await withSession(database);
        const { rows } = await sql<{ schema: string }>`SELECT current_schema() AS schema`.execute(
          database.db,
        );
        await release.connect();
        await release.query(`SET search_path = "${rows[0]?.schema}"`);
        // The release's batch (final position 1000, ends the session), held open mid-way: its
        // compiled statements, run on a connection of their own.
        const batch = await releaseStatements(database);
        await release.query("BEGIN");
        for (const statement of batch)
          await release.query(statement.sql, [...statement.parameters]);
        // A heartbeat (position 500) whose batch starts while the release is not committed.
        const heartbeat = repos.playback.recordHeartbeat(report(500, false, "h2"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        await release.query("COMMIT");
        await heartbeat;
        expect(await progressOf(database)).toBe(1000);
        const session = await repos.playback.get("ps1");
        expect(session?.endedAt).toBe(NOW);
        expect(session?.positionSec).toBe(1000);
      } finally {
        await release.end();
        await cleanup();
      }
    },
  );

  it("sqlite: a heartbeat after the release writes nothing", async () => {
    const { database, cleanup } = await createSqliteHarness();
    try {
      const repos = await withSession(database);
      await repos.playback.recordHeartbeat(report(1000, true, "h1"));
      await repos.playback.recordHeartbeat(report(500, false, "h2"));
      expect(await progressOf(database)).toBe(1000);
    } finally {
      await cleanup();
    }
  });
});

/** The statements `recordHeartbeat` sends for the release, captured instead of executed. */
async function releaseStatements(database: Database) {
  const captured: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const capturing: Database = {
    ...database,
    batch: (async (
      queries: readonly { compile(): { sql: string; parameters: readonly unknown[] } }[],
    ) => {
      for (const query of queries) captured.push(query.compile());
      return queries.map(() => ({ rows: [], numAffectedRows: 0 }));
    }) as Database["batch"],
  };
  await createRepositories(capturing).playback.recordHeartbeat(report(1000, true, "h1"));
  return captured;
}
