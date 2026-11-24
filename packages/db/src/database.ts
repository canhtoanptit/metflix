import { AppError } from "@webflix/core";
import {
  type Compilable,
  type CompiledQuery,
  type Dialect,
  type InferResult,
  Kysely,
} from "kysely";
import { MAX_BOUND_PARAMETERS, type SqlDialect } from "./dialect.ts";
import type { DB } from "./schema.ts";

/** Result of one statement in a batch. */
export interface StatementResult<R = Record<string, unknown>> {
  rows: R[];
  numAffectedRows: number;
}

type BatchResults<Q extends readonly Compilable<unknown>[]> = {
  -readonly [K in keyof Q]: StatementResult<InferResult<Q[K]>[number]>;
};

/** Counters for tests and metrics. `queries` counts round trips the way D1 bills them. */
/** A connection pool's state (PostgreSQL). */
export interface PoolStats {
  /** Connections open, idle or lent. */
  total: number;
  /** Open and idle in the pool. */
  idle: number;
  /** Requests waiting for a connection. */
  waiting: number;
}

/** What `warm()` did. */
export interface PoolWarmth {
  /** Connections opened by this call. */
  opened: number;
  /** Connections open afterwards. */
  total: number;
}

export interface DatabaseStats {
  /** Round trips: one per Kysely query, one per batch. */
  queries: number;
  /** Statements, counting each statement of a batch. */
  statements: number;
}

/**
 * One database, any dialect. Repositories use `db` for single statements and `batch` for
 * anything that must be atomic or that should share one round trip.
 */
export interface Database {
  readonly dialect: SqlDialect;
  readonly db: Kysely<DB>;
  /**
   * Run statements atomically, in order, in one round trip where the backend allows it:
   * a D1 `batch()`, a Postgres transaction, a SQLite `BEGIN IMMEDIATE ... COMMIT`. Statements
   * cannot see each other's results from the application side: express conditions in SQL.
   * Results are positional and typed from the queries.
   */
  batch<const Q extends readonly Compilable<unknown>[]>(queries: Q): Promise<BatchResults<Q>>;
  readonly stats: DatabaseStats;
  /**
   * PostgreSQL: open connections until the pool holds its minimum (`minConnections`), which it
   * then keeps however long they idle, so a burst is served from open connections. A process calls
   * it before it takes traffic and again after a connection loss. Absent elsewhere.
   */
  warm?(): Promise<PoolWarmth>;
  /** PostgreSQL: the pool right now. Absent elsewhere. */
  poolStats?(): PoolStats;
  close(): Promise<void>;
}

/** Raw result of one compiled statement, as each dialect's batch executor reports it. */
export interface RawStatementResult {
  rows: unknown[];
  numAffectedRows: number;
}

export interface DatabaseParts {
  dialect: SqlDialect;
  kyselyDialect: Dialect;
  /** Executes compiled statements atomically (see `Database.batch`). */
  executeBatch(statements: readonly CompiledQuery[]): Promise<RawStatementResult[]>;
  warm?(): Promise<PoolWarmth>;
  poolStats?(): PoolStats;
  close(): Promise<void>;
}

export class TooManyParametersError extends RangeError {
  override readonly name = "TooManyParametersError";

  constructor(count: number, sql: string) {
    super(
      `Statement binds ${count} parameters; D1 allows ${MAX_BOUND_PARAMETERS}. Chunk the write. SQL: ${sql.slice(0, 200)}`,
    );
  }
}

/**
 * Enforced on every dialect, not only D1: code that runs in dev (SQLite) and k8s (Postgres)
 * then also runs on D1.
 */
export function assertParameterCount(compiled: { sql: string; parameters: readonly unknown[] }) {
  if (compiled.parameters.length > MAX_BOUND_PARAMETERS) {
    throw new TooManyParametersError(compiled.parameters.length, compiled.sql);
  }
}

export function createDatabase(parts: DatabaseParts): Database {
  const stats: DatabaseStats = { queries: 0, statements: 0 };
  const db = new Kysely<DB>({
    dialect: parts.kyselyDialect,
    log: () => {
      stats.queries += 1;
      stats.statements += 1;
    },
  });
  return {
    dialect: parts.dialect,
    db,
    stats,
    ...(parts.warm ? { warm: parts.warm } : {}),
    ...(parts.poolStats ? { poolStats: parts.poolStats } : {}),
    async batch<const Q extends readonly Compilable<unknown>[]>(queries: Q) {
      if (queries.length === 0) return [] as unknown as BatchResults<Q>;
      const compiled = queries.map((query) => query.compile());
      for (const statement of compiled) assertParameterCount(statement);
      stats.queries += 1;
      stats.statements += compiled.length;
      const results = await parts.executeBatch(compiled);
      return results as unknown as BatchResults<Q>;
    },
    async close() {
      await db.destroy();
      await parts.close();
    },
  };
}

/** Split rows so that one multi-row INSERT stays within the parameter cap. */
export function chunkRows<T>(rows: readonly T[], columnsPerRow: number): T[][] {
  const size = Math.max(1, Math.floor(MAX_BOUND_PARAMETERS / columnsPerRow));
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

/** Split values for `IN (...)` lists. */
export function chunkValues<T>(values: readonly T[], size = MAX_BOUND_PARAMETERS - 10): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/** Network errors that mean the database server cannot be reached. */
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

/**
 * Connection-level failures, by message: node-postgres's own (a dropped or timed-out
 * connection, no free connection in time), SQLite's (the file cannot be opened, or stays locked
 * by another process past the busy timeout), D1's transient ones (as Cloudflare documents them).
 */
const UNREACHABLE_MESSAGES =
  /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|Query read timeout|unable to open database file|database is locked|Network connection lost|D1 DB is overloaded|Cannot resolve D1 DB due to transient issue|storage caused object to be reset/i;

/**
 * The connection was lost after COMMIT went out and before its answer came back: the server
 * may have committed the transaction, or not. Nothing can tell from this side; the caller is
 * told so (the request answers 503 with a detail that says the change may have been saved).
 */
export class CommitOutcomeUnknownError extends Error {
  override readonly name = "CommitOutcomeUnknownError";

  constructor(cause: unknown) {
    super("The connection was lost while committing: the transaction may or may not be applied", {
      cause,
    });
  }
}

/**
 * True when `error` (or its cause chain) means the database cannot be reached right now: a
 * refused, dropped or timed-out connection, a server that is shutting down, starting or out of
 * connections (SQLSTATE class 08, 57P01-57P03, 53300), a SQLite file that cannot be opened or
 * stays locked, a transient D1 failure. Never a fault of the statement itself (constraint,
 * syntax, statement timeout): those stay 500s, because retrying will not help.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof record.code === "string") {
      if (UNREACHABLE_CODES.has(record.code)) return true;
      if (/^08[0-9A-Z]{3}$/.test(record.code)) return true;
      if (["57P01", "57P02", "57P03", "53300"].includes(record.code)) return true;
    }
    if (typeof record.message === "string" && UNREACHABLE_MESSAGES.test(record.message)) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/** The database cannot be reached: `service_unavailable` (503, `Retry-After`), else rethrow. */
function unavailableOr(error: unknown): unknown {
  if (!isDatabaseUnavailable(error)) return error;
  return new AppError("service_unavailable", {
    detail:
      error instanceof CommitOutcomeUnknownError
        ? "The database stopped answering while saving this change: it may or may not have been saved. Check before trying again."
        : "The database cannot be reached right now. Try again in a moment.",
    cause: error,
  });
}

/**
 * Every method of `target` with its rejections passed through `unavailableOr`: what the
 * repositories and the search index hand to the services, so an outage answers 503 on every
 * dialect instead of 500.
 */
export function withUnavailableErrors<T extends object>(target: T): T {
  const guarded = { ...target } as Record<string, unknown>;
  for (const [name, value] of Object.entries(target)) {
    if (typeof value !== "function") continue;
    guarded[name] = async (...args: unknown[]) => {
      try {
        return await (value as (...inner: unknown[]) => Promise<unknown>)(...args);
      } catch (error) {
        throw unavailableOr(error);
      }
    };
  }
  return guarded as T;
}

/** True when `error` (or its cause chain) is a unique-constraint violation on any dialect. */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && current !== null) {
      const record = current as { code?: unknown; message?: unknown; cause?: unknown };
      if (record.code === "23505") return true; // Postgres unique_violation
      if (typeof record.message === "string" && /UNIQUE constraint failed/i.test(record.message)) {
        return true; // SQLite, D1
      }
      current = record.cause;
    } else {
      break;
    }
  }
  return false;
}
