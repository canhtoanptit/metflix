/**
 * PostgreSQL through `pg` (k8s mode). Node-only entry point: `@webflix/db/postgres`.
 */
import { type CompiledQuery, PostgresDialect } from "kysely";
import pg from "pg";
import {
  assertParameterCount,
  CommitOutcomeUnknownError,
  createDatabase,
  type Database,
  isDatabaseUnavailable,
} from "./database.ts";

/**
 * Who is using the pool, which decides how long a statement may take (docs/DECISIONS.md D42):
 *
 * - `request`: the HTTP API. Its statements take milliseconds; a request that waits longer than
 *   a few seconds on the database serves the member better as a 503 they can retry. Statements
 *   5 s on the server, 7 s on the client: with at most 5 s to get a pooled connection
 *   (`connectTimeoutMs`), a request waits at most 12 s on the database, well inside the
 *   gateway's 60 s.
 * - `background`: the job worker and the scheduler's jobs (rollups recompute whole days).
 *   60 s and 65 s; a running job keeps its lease alive meanwhile.
 * - `maintenance`: `migrate` and `seed` (DDL, the catalog's large batches). 10 minutes, so a
 *   lost database still ends the Job instead of leaving it to TCP.
 */
export type PostgresRole = "request" | "background" | "maintenance";

export const POSTGRES_ROLE_TIMEOUTS: Readonly<
  Record<PostgresRole, { statementTimeoutMs: number; queryTimeoutMs: number }>
> = {
  request: { statementTimeoutMs: 5_000, queryTimeoutMs: 7_000 },
  background: { statementTimeoutMs: 60_000, queryTimeoutMs: 65_000 },
  maintenance: { statementTimeoutMs: 600_000, queryTimeoutMs: 605_000 },
};

/** Without a role: the statement timeout this package always had, now bounded client-side. */
const DEFAULT_TIMEOUTS = { statementTimeoutMs: 15_000, queryTimeoutMs: 17_000 };

export interface PostgresOptions {
  /** `postgres://user:pass@host:port/db`. */
  connectionString: string;
  /** Pool size per process. Default 10. */
  maxConnections?: number;
  /** Sets `search_path` on every connection (isolated schemas in tests). */
  schema?: string;
  /** The timeouts of this role (`POSTGRES_ROLE_TIMEOUTS`); the two options below override them. */
  role?: PostgresRole;
  /**
   * Server-side `statement_timeout` in milliseconds (0: none). The server cancels a statement
   * that runs longer (`57014`, a 500: retrying it would be as slow).
   */
  statementTimeoutMs?: number;
  /**
   * Client-side bound on a statement's answer in milliseconds (0: none). It fires only when the
   * server cannot answer (a partition, a lost host): give it a margin over `statementTimeoutMs`
   * so a reachable server's own timeout answers first. The statement fails as unavailable (503)
   * and its connection is destroyed. The server also ends a transaction left idle that long
   * (`idle_in_transaction_session_timeout`), so a transaction abandoned by a lost client does not
   * keep its locks.
   */
  queryTimeoutMs?: number;
  /**
   * TCP keepalive: the first probe after this much idle time, in milliseconds (0: off).
   * Default 10 000. Probe interval and count are the host's (`net.ipv4.tcp_keepalive_intvl`,
   * `_probes`); they decide how soon a dead idle connection is noticed.
   */
  keepAliveInitialDelayMs?: number;
  /**
   * Bound on opening a connection, and on waiting for a free one when the pool is busy.
   * Default 5 000. Without it a connection attempt to an address that silently drops packets
   * (a database pod being replaced) hangs for minutes and every query queues behind it.
   */
  connectTimeoutMs?: number;
  applicationName?: string;
  /**
   * A pooled connection failed outside a statement's own answer (server restarted or shutting
   * down, network cut): idle in the pool, or lent to a request between two statements. Called
   * once per connection. The connection is discarded and the next query opens a new one; the
   * request that held it fails with the error. This is for logging.
   */
  onIdleConnectionError?: (error: Error) => void;
}

const INT8_OID = 20;
const NUMERIC_OID = 1700;

/**
 * Timestamps are int8 epoch milliseconds and `count(*)` is int8: return both as JS numbers
 * (exact below 2^53) so every dialect yields the same row shapes. `sum()` over integers is
 * numeric in Postgres; it becomes a number too.
 */
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === INT8_OID) return (value: string) => Number(value);
    if (oid === NUMERIC_OID) return (value: string) => Number(value);
    return pg.types.getTypeParser(oid, format);
  },
};

/**
 * End a client's connection at once. A connection whose statement went unanswered must not wait
 * for a graceful close (that waits on the same silent network): the pool discards the client,
 * and this releases its socket now.
 */
function destroyConnection(client: pg.PoolClient): void {
  (
    client as unknown as { connection?: { stream?: { destroy(): void } } }
  ).connection?.stream?.destroy();
}

export function createPostgresDatabase(options: PostgresOptions): Database {
  const role = options.role ? POSTGRES_ROLE_TIMEOUTS[options.role] : DEFAULT_TIMEOUTS;
  const statementTimeoutMs = options.statementTimeoutMs ?? role.statementTimeoutMs;
  const queryTimeoutMs = options.queryTimeoutMs ?? role.queryTimeoutMs;
  const keepAliveInitialDelayMs = options.keepAliveInitialDelayMs ?? 10_000;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? "webflix",
    connectionTimeoutMillis: options.connectTimeoutMs ?? 5_000,
    // 0 (none) is left out: node-postgres sends only set values.
    ...(statementTimeoutMs > 0 ? { statement_timeout: statementTimeoutMs } : {}),
    ...(queryTimeoutMs > 0
      ? { query_timeout: queryTimeoutMs, idle_in_transaction_session_timeout: queryTimeoutMs }
      : {}),
    keepAlive: keepAliveInitialDelayMs > 0,
    keepAliveInitialDelayMillis: keepAliveInitialDelayMs,
    types,
    ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
  });
  // A node-postgres client emits 'error' when its connection fails outside a statement's own
  // answer: a server's `FATAL 57P01` (graceful shutdown, failover) with no statement in flight,
  // and the socket closing after any FATAL. With no listener that is an unhandled 'error' event,
  // which ends the process: one database restart would take every replica down instead of
  // failing the requests in flight. pg-pool listens only while a client is idle in the pool (it
  // removes its listener when lending one), so every client also gets a listener of its own for
  // its whole life (once, on connect: never doubled by reuse). The pool's listener reports idle
  // clients; this one reports lent ones, once each. A client that failed is not queryable any
  // more: its pending and later statements fail, and the pool discards it on release.
  const lent = new WeakSet<pg.PoolClient>();
  const reported = new WeakSet<pg.PoolClient>();
  const report = (client: pg.PoolClient, error: Error) => {
    if (reported.has(client)) return;
    reported.add(client);
    options.onIdleConnectionError?.(error);
  };
  pool.on("error", (error, client) => report(client, error));
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      if (lent.has(client)) report(client, error);
    });
  });
  pool.on("acquire", (client) => lent.add(client));
  pool.on("release", (_error, client) => lent.delete(client));

  // Every query, through Kysely or a batch, passes the D1 parameter cap check. A client whose
  // connection failed or whose statement went unanswered is discarded with its socket
  // destroyed: never lent again (a timed-out statement may still be running or stuck on it).
  const guardedPool = {
    options: pool.options,
    end: () => pool.end(),
    async connect() {
      const client = await pool.connect();
      let failed: Error | undefined;
      return {
        query: ((sql: string, parameters: readonly unknown[]) => {
          assertParameterCount({ sql, parameters });
          return client.query(sql, parameters as unknown[]).catch((error: unknown) => {
            if (isDatabaseUnavailable(error)) failed = error as Error;
            throw error;
          });
        }) as never,
        release: (destroy?: boolean) => {
          if (failed) destroyConnection(client);
          client.release(destroy || failed);
        },
      };
    },
  };

  return createDatabase({
    dialect: "postgres",
    kyselyDialect: new PostgresDialect({ pool: guardedPool }),
    async executeBatch(statements: readonly CompiledQuery[]) {
      const client = await pool.connect();
      // Set when the connection may not go back to the pool: it is gone, or its transaction
      // could not be rolled back (a client left inside a transaction would poison the next
      // request).
      let discard: Error | undefined;
      let committing = false;
      try {
        await client.query("BEGIN");
        const results = [];
        for (const statement of statements) {
          assertParameterCount(statement);
          const result = await client.query(statement.sql, statement.parameters as unknown[]);
          results.push({ rows: result.rows, numAffectedRows: result.rowCount ?? 0 });
        }
        committing = true;
        await client.query("COMMIT");
        return results;
      } catch (error) {
        if (isDatabaseUnavailable(error)) {
          // The connection is lost or unanswered; its socket is destroyed below. Before COMMIT
          // went out, nothing of the transaction can be applied: the server rolls it back when it
          // sees the connection gone, or when it has sat idle in the transaction past the budget.
          // During COMMIT the server may have committed: the outcome is unknown, and said so.
          discard = error as Error;
          if (committing) throw new CommitOutcomeUnknownError(error);
        } else {
          await client.query("ROLLBACK").catch((rollbackError: unknown) => {
            discard =
              rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
          });
        }
        throw error;
      } finally {
        if (discard) destroyConnection(client);
        client.release(discard);
      }
    },
    async close() {
      // Kysely's destroy() already ended the pool.
    },
  });
}
