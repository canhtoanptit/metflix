/**
 * PostgreSQL through `pg` (k8s mode). Node-only entry point: `@webflix/db/postgres`.
 */
import { type CompiledQuery, PostgresDialect } from "kysely";
import pg from "pg";
import {
  assertParameterCount,
  createDatabase,
  type Database,
  isDatabaseUnavailable,
} from "./database.ts";

export interface PostgresOptions {
  /** `postgres://user:pass@host:port/db`. */
  connectionString: string;
  /** Pool size per process. Default 10. */
  maxConnections?: number;
  /** Sets `search_path` on every connection (isolated schemas in tests). */
  schema?: string;
  /** Statement timeout in milliseconds. Default 15 000. */
  statementTimeoutMs?: number;
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

export function createPostgresDatabase(options: PostgresOptions): Database {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? "webflix",
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 5_000,
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
  // connection failed goes back to the pool marked as such, so it is discarded at once instead
  // of being lent to the next request before its socket has finished closing.
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
        release: (destroy?: boolean) => client.release(destroy || failed),
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
      try {
        await client.query("BEGIN");
        const results = [];
        for (const statement of statements) {
          assertParameterCount(statement);
          const result = await client.query(statement.sql, statement.parameters as unknown[]);
          results.push({ rows: result.rows, numAffectedRows: result.rowCount ?? 0 });
        }
        await client.query("COMMIT");
        return results;
      } catch (error) {
        if (isDatabaseUnavailable(error)) {
          // The server ended the transaction with the connection: nothing of it was applied
          // (COMMIT never completed), and there is nothing to roll back.
          discard = error as Error;
        } else {
          await client.query("ROLLBACK").catch((rollbackError: unknown) => {
            discard =
              rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
          });
        }
        throw error;
      } finally {
        client.release(discard);
      }
    },
    async close() {
      // Kysely's destroy() already ended the pool.
    },
  });
}
