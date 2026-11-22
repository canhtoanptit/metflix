/**
 * @webflix/db: Kysely schema, migrations, repositories and the SQL search index.
 *
 * This entry is portable (Node and workerd): it never imports a driver. Dialect factories are
 * separate entry points so a Worker bundle never pulls in `pg` or `node:` modules:
 *
 * - `@webflix/db/sqlite`   `createSqliteDatabase({ path })`   node:sqlite (dev, tests)
 * - `@webflix/db/postgres` `createPostgresDatabase({ connectionString })`   pg (k8s)
 * - `@webflix/db/d1`       `createD1Database(env.DB)`   Cloudflare D1 (portable)
 */
export {
  assertParameterCount,
  CommitOutcomeUnknownError,
  chunkRows,
  chunkValues,
  createDatabase,
  type Database,
  type DatabaseParts,
  type DatabaseStats,
  isDatabaseUnavailable,
  isUniqueViolation,
  type RawStatementResult,
  type StatementResult,
  TooManyParametersError,
} from "./database.ts";
export { MAX_BOUND_PARAMETERS, SQL_DIALECTS, type SqlDialect } from "./dialect.ts";
export {
  compileMigration,
  d1MigrationFile,
  MIGRATIONS,
  type MigrationOutcome,
  migrateToLatest,
  migrationProvider,
  type SchemaMigration,
} from "./migrations/index.ts";
export { createIdentityRepository } from "./repositories/areas/identity.ts";
export { createDatabaseRecommendationStore } from "./repositories/areas/personalisation.ts";
export { CATALOG_VERSION_KEY } from "./repositories/catalog.ts";
export { createRepositories, resetDatabase } from "./repositories/index.ts";
export type { DB } from "./schema.ts";
export { TABLES } from "./schema.ts";
export { createSqlSearchIndex } from "./search.ts";
