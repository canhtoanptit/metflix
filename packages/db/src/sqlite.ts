/**
 * SQLite on Node's built-in `node:sqlite` (dev mode, tests). Node-only entry point:
 * `@webflix/db/sqlite`. Never imported by the Worker bundle.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { type CompiledQuery, SqliteDialect, type SqliteStatement } from "kysely";
import { assertParameterCount, createDatabase, type Database } from "./database.ts";

export interface SqliteOptions {
  /** File path, or `:memory:`. Parent directories are created. */
  path: string;
}

const STATEMENT_CACHE_SIZE = 256;

function toSqliteValue(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SQLInputValue;
}

/**
 * Prepared statements cached by SQL text: preparing is most of the cost of a small query,
 * and repositories issue the same few dozen statements over and over.
 */
class StatementCache {
  private readonly statements = new Map<string, StatementSync>();
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  get(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement) {
      // Refresh recency.
      this.statements.delete(sql);
    } else {
      statement = this.database.prepare(sql);
      if (this.statements.size >= STATEMENT_CACHE_SIZE) {
        const oldest = this.statements.keys().next().value;
        if (oldest !== undefined) this.statements.delete(oldest);
      }
    }
    this.statements.set(sql, statement);
    return statement;
  }
}

function run(
  cache: StatementCache,
  sql: string,
  parameters: readonly unknown[],
): { rows: unknown[]; numAffectedRows: number } {
  assertParameterCount({ sql, parameters });
  const statement = cache.get(sql);
  const values = parameters.map(toSqliteValue);
  if (statement.columns().length > 0) {
    return { rows: statement.all(...values), numAffectedRows: 0 };
  }
  const result = statement.run(...values);
  return { rows: [], numAffectedRows: Number(result.changes) };
}

export function createSqliteDatabase(options: SqliteOptions): Database {
  if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
  const database = new DatabaseSync(options.path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  if (options.path !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
  }
  const cache = new StatementCache(database);
  let closed = false;

  // The better-sqlite3-shaped object Kysely's SqliteDialect drives.
  const kyselyDatabase = {
    close() {
      // Closed by `Database.close`, after Kysely lets go.
    },
    prepare(sql: string): SqliteStatement {
      return {
        get reader() {
          return cache.get(sql).columns().length > 0;
        },
        all: (parameters) => run(cache, sql, parameters).rows,
        run: (parameters) => {
          const result = run(cache, sql, parameters);
          return { changes: result.numAffectedRows, lastInsertRowid: 0 };
        },
        iterate: (parameters) => {
          assertParameterCount({ sql, parameters });
          return cache.get(sql).iterate(...parameters.map(toSqliteValue));
        },
      };
    },
  };

  return createDatabase({
    dialect: "sqlite",
    kyselyDialect: new SqliteDialect({ database: kyselyDatabase }),
    // Synchronous from BEGIN to COMMIT: no other query in this process can interleave, which
    // is what makes the batch atomic with respect to concurrent requests.
    async executeBatch(statements: readonly CompiledQuery[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) =>
          run(cache, statement.sql, statement.parameters),
        );
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  });
}
