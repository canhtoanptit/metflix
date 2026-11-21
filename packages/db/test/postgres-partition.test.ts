/**
 * A database that stops answering without closing anything (a network partition, a host lost
 * with its connections) must cost a request its time budget, not TCP's 15 minutes. A statement
 * with no answer fails client-side as unavailable (503 through the repositories), its connection
 * is destroyed (its socket may still carry the stuck statement), the pool recovers once the
 * network heals, and a transaction frozen mid-way is never half-applied. A loss during COMMIT is
 * reported as an unknown outcome. The partition is a TCP proxy in front of the test database that
 * can be frozen: it stops passing bytes either way and closes nothing. Runs with
 * WEBFLIX_TEST_POSTGRES_URL (`pnpm --filter @webflix/db test:postgres`).
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import { AppError } from "@webflix/core";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { type Database, withUnavailableErrors } from "../src/database.ts";
import { migrateToLatest } from "../src/migrations/index.ts";
import { createPostgresDatabase } from "../src/postgres.ts";
import { createRepositories } from "../src/repositories/index.ts";
import { postgresAvailable, postgresUrl } from "./harness.ts";

/** The test's own port (the suite's range is 4900-4949). */
const PROXY_PORT = 4941;

/** A TCP proxy to the test database that can stop passing bytes without closing anything. */
class PartitionProxy {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private held: Array<() => void> = [];
  private frozen = false;
  private freezeOn: { pattern: string; afterForwarding: boolean } | null = null;
  /** Client connections closed by the application side (destroyed by the pool). */
  clientCloses = 0;

  constructor(target: URL) {
    this.server = net.createServer((client) => {
      const upstream = net.connect(Number(target.port || 5432), target.hostname);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => {});
      }
      const pass = (from: net.Socket, to: net.Socket, inspect: boolean) => {
        from.on("data", (chunk: Buffer) => {
          const send = () => {
            if (!to.destroyed) to.write(chunk);
          };
          if (inspect && this.freezeOn && chunk.includes(this.freezeOn.pattern)) {
            const { afterForwarding } = this.freezeOn;
            this.freezeOn = null;
            if (afterForwarding) send();
            this.frozen = true;
            if (!afterForwarding) this.held.push(send);
            return;
          }
          if (this.frozen) this.held.push(send);
          else send();
        });
        from.on("close", () => {
          if (from === client) this.clientCloses += 1;
          const close = () => to.destroy();
          if (this.frozen) this.held.push(close);
          else close();
        });
      };
      pass(client, upstream, true);
      pass(upstream, client, false);
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(PROXY_PORT, "127.0.0.1", resolve));
  }

  /** Stop passing bytes (and closes) either way, from now. */
  freeze(): void {
    this.frozen = true;
  }

  /** Freeze when the application sends `pattern`, after or before passing that statement on. */
  freezeWhenSent(pattern: string, afterForwarding: boolean): void {
    this.freezeOn = { pattern, afterForwarding };
  }

  /** The network heals: what was held goes through. */
  thaw(): void {
    this.frozen = false;
    const held = this.held;
    this.held = [];
    for (const deliver of held) deliver();
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Rows a direct connection sees under `key` in the test schema. */
function metaRows(schema: string, key: string): Promise<number> {
  return admin(async (client) => {
    const { rows } = await client.query(`SELECT 1 FROM ${schema}.meta WHERE key = $1`, [key]);
    return rows.length;
  });
}

function backends(applicationName: string): Promise<string[]> {
  return admin(async (client) => {
    const { rows } = await client.query<{ state: string }>(
      "SELECT state FROM pg_stat_activity WHERE application_name = $1",
      [applicationName],
    );
    return rows.map((row) => row.state);
  });
}

/** Statements get 1 s on the server and 1.5 s on the client: the mechanism, at test speed. */
const BUDGET = { statementTimeoutMs: 1_000, queryTimeoutMs: 1_500 };

describe.skipIf(!postgresAvailable)("Postgres behind a partition", () => {
  let proxy: PartitionProxy | null = null;
  let database: Database | null = null;
  afterEach(async () => {
    proxy?.thaw();
    await database?.close();
    await proxy?.close();
    proxy = null;
    database = null;
  });

  async function setUp() {
    const target = new URL(postgresUrl);
    proxy = new PartitionProxy(target);
    await proxy.listen();
    const viaProxy = new URL(postgresUrl);
    viaProxy.hostname = "127.0.0.1";
    viaProxy.port = String(PROXY_PORT);
    const schema = `t_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await admin((client) => client.query(`CREATE SCHEMA ${schema}`));
    const applicationName = `webflix-partition-${randomUUID().slice(0, 8)}`;
    database = createPostgresDatabase({
      connectionString: viaProxy.toString(),
      schema,
      maxConnections: 2,
      applicationName,
      ...BUDGET,
    });
    await migrateToLatest(database);
    return { proxy, database, repos: createRepositories(database), schema, applicationName };
  }

  it("fails a statement with no answer within its budget, discards the connection, recovers", async () => {
    const { proxy, repos } = await setUp();
    await repos.meta.set("before", "ok", Date.now());
    proxy.freeze();
    const started = performance.now();
    const outcome = await repos.meta.get("before").then(
      () => null,
      (error: unknown) => error,
    );
    const waitedMs = performance.now() - started;
    expect(AppError.is(outcome, "service_unavailable")).toBe(true);
    expect(waitedMs).toBeLessThan(BUDGET.queryTimeoutMs + 1_000);
    // The stuck connection was destroyed, not kept for the next request.
    expect(proxy.clientCloses).toBeGreaterThanOrEqual(1);
    proxy.thaw();
    expect(await repos.meta.get("before")).toBe("ok");
  });

  it("recovers when the database comes back behind a new connection path", async () => {
    const { proxy: lost, repos } = await setUp();
    await repos.meta.set("kept", "ok", Date.now());
    lost.freeze();
    const outcome = await repos.meta.get("kept").then(
      () => null,
      (error: unknown) => error,
    );
    expect(AppError.is(outcome, "service_unavailable")).toBe(true);
    // The host is gone for good; a replacement answers at the same address.
    await lost.close();
    proxy = new PartitionProxy(new URL(postgresUrl));
    await proxy.listen();
    expect(await repos.meta.get("kept")).toBe("ok");
  });

  it("never applies half of a transaction frozen mid-way", async () => {
    const { proxy, database, repos, schema, applicationName } = await setUp();
    const { db } = database;
    const write = (key: string) =>
      db.insertInto("meta").values({ key, value: "x", updated_at: Date.now() });
    // Frozen once the second statement has gone out: the first insert is done, uncommitted.
    proxy.freezeWhenSent("frozen-2", false);
    const outcome = await withUnavailable(() =>
      database.batch([write("frozen-1"), write("frozen-2"), write("frozen-3")]),
    );
    expect(AppError.is(outcome, "service_unavailable")).toBe(true);
    expect((outcome as AppError).detail).not.toMatch(/may or may not/);
    // Never visible to anyone else, and the server ends the abandoned transaction itself
    // (idle in transaction past the budget): nothing of it is ever applied.
    expect(await metaRows(schema, "frozen-1")).toBe(0);
    await expect
      .poll(() => backends(applicationName), { timeout: 10_000 })
      .not.toContain("idle in transaction");
    expect(await metaRows(schema, "frozen-1")).toBe(0);
    proxy.thaw();
    await database.batch([write("after-thaw")]);
    expect(await repos.meta.get("after-thaw")).toBe("x");
  });

  it("reports a loss during COMMIT as an unknown outcome", async () => {
    const { proxy, database, schema } = await setUp();
    const { db } = database;
    // COMMIT reaches the server; its answer never comes back.
    proxy.freezeWhenSent("COMMIT", true);
    const outcome = await withUnavailable(() =>
      database.batch([db.insertInto("meta").values({ key: "c-1", value: "x", updated_at: 1 })]),
    );
    expect(AppError.is(outcome, "service_unavailable")).toBe(true);
    expect((outcome as AppError).detail).toMatch(/may or may not have been saved/);
    // Here it was saved: the server committed, only the acknowledgement was lost.
    await expect.poll(() => metaRows(schema, "c-1"), { timeout: 5_000 }).toBe(1);
  });
});

/** What a repository does with a batch: an outage is `service_unavailable`. */
function withUnavailable(run: () => Promise<unknown>): Promise<unknown> {
  return withUnavailableErrors({ run })
    .run()
    .then(
      () => null,
      (error: unknown) => error,
    );
}
