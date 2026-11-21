import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createD1Database } from "../../src/d1.ts";
import type { Database } from "../../src/database.ts";
import { resetDatabase } from "../../src/repositories/index.ts";

let migrated: Promise<void> | undefined;

/**
 * Applies the generated D1 migration files once per isolate (idempotent: applied migrations
 * are recorded in `d1_migrations`), the same files `wrangler d1 migrations apply` uses.
 */
export function migrateD1(): Promise<void> {
  migrated ??= applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  return migrated;
}

/** A migrated D1 `Database` over the test binding, without touching its rows. */
export async function d1Database(): Promise<Database> {
  await migrateD1();
  return createD1Database(env.DB);
}

/** A migrated, empty D1 `Database`: the factory for contract suites (fresh state per test). */
export async function freshD1Database(): Promise<Database> {
  const database = await d1Database();
  await resetDatabase(database);
  return database;
}
