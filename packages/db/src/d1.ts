/**
 * Cloudflare D1 dialect (cloudflare mode). Portable: it only talks to the D1 binding, so it
 * runs in workerd. Entry point: `@webflix/db/d1`.
 *
 * D1 constraints this design follows (https://developers.cloudflare.com/d1/platform/limits/):
 * - no interactive transactions: `beginTransaction` throws; atomic writes go through
 *   `Database.batch`, which maps to `D1Database.batch()` (one implicit transaction);
 * - at most 100 bound parameters per statement (enforced for every dialect, see `database.ts`);
 * - every query is a network round trip and a Worker invocation may issue at most 1 000 (Paid)
 *   or 50 (Free); a batch counts as one;
 * - at most 100 columns per table and per result, 5 terms per compound SELECT, 50-byte LIKE patterns.
 */
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { assertParameterCount, createDatabase, type Database } from "./database.ts";

/** The subset of the Workers `D1Database` binding used here (structural: no workers-types import). */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all(): Promise<D1ResultLike>;
}

export interface D1ResultLike {
  results?: unknown[];
  meta?: { changes?: number; last_row_id?: number };
}

function toD1Value(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  return value;
}

function prepare(binding: D1DatabaseLike, query: CompiledQuery): D1PreparedStatementLike {
  assertParameterCount(query);
  const statement = binding.prepare(query.sql);
  return query.parameters.length > 0
    ? statement.bind(...query.parameters.map(toD1Value))
    : statement;
}

function toResult(result: D1ResultLike): { rows: unknown[]; numAffectedRows: number } {
  return { rows: result.results ?? [], numAffectedRows: result.meta?.changes ?? 0 };
}

class D1Connection implements DatabaseConnection {
  private readonly binding: D1DatabaseLike;

  constructor(binding: D1DatabaseLike) {
    this.binding = binding;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result = toResult(await prepare(this.binding, compiledQuery).all());
    return {
      rows: result.rows as R[],
      numAffectedRows: BigInt(result.numAffectedRows),
    };
  }

  // biome-ignore lint/correctness/useYield: streaming is not supported by D1; the generator only throws.
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("D1 does not support streaming queries");
  }
}

class D1Driver implements Driver {
  private readonly connection: D1Connection;

  constructor(binding: D1DatabaseLike) {
    this.connection = new D1Connection(binding);
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }

  async beginTransaction(): Promise<void> {
    throw new Error(
      "D1 has no interactive transactions. Express the unit of work as one Database.batch([...]).",
    );
  }

  async commitTransaction(): Promise<void> {}

  async rollbackTransaction(): Promise<void> {}

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

/** Kysely dialect over a D1 binding (SQLite SQL). */
export class D1Dialect implements Dialect {
  private readonly binding: D1DatabaseLike;

  constructor(binding: D1DatabaseLike) {
    this.binding = binding;
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new D1Driver(this.binding);
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }

  // biome-ignore lint/suspicious/noExplicitAny: Kysely's Dialect interface signature.
  createIntrospector(db: Kysely<any>) {
    return new SqliteIntrospector(db);
  }
}

/**
 * A `Database` over a D1 binding. Cheap to create: build one per request (or per isolate) from
 * `env.DB`. Schema migrations are applied by `wrangler d1 migrations apply` from the generated
 * SQL files in `packages/db/migrations/d1`.
 */
export function createD1Database(binding: D1DatabaseLike): Database {
  return createDatabase({
    dialect: "d1",
    kyselyDialect: new D1Dialect(binding),
    async executeBatch(statements) {
      const results = await binding.batch(statements.map((query) => prepare(binding, query)));
      return results.map(toResult);
    },
    async close() {},
  });
}
