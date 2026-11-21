import type { Repositories } from "@webflix/core";
import { sql } from "kysely";
import { type Database, withUnavailableErrors } from "../database.ts";
import { TABLES } from "../schema.ts";
import {
  createLibraryRepository,
  createMetaRepository,
  createNotificationRepository,
  createPlaybackRepository,
  createStatsRepository,
} from "./activity.ts";
import { createCatalogRepository, createSeedRepository } from "./catalog.ts";
import {
  createAccountRepository,
  createProfileRepository,
  createSessionRepository,
} from "./identity.ts";

/**
 * Every repository over one database (any dialect). A database that cannot be reached surfaces
 * as `service_unavailable` from every method (`withUnavailableErrors`).
 */
export function createRepositories(database: Database): Repositories {
  return withUnavailableErrors({
    accounts: withUnavailableErrors(createAccountRepository(database)),
    sessions: withUnavailableErrors(createSessionRepository(database)),
    profiles: withUnavailableErrors(createProfileRepository(database)),
    catalog: withUnavailableErrors(createCatalogRepository(database)),
    library: withUnavailableErrors(createLibraryRepository(database)),
    playback: withUnavailableErrors(createPlaybackRepository(database)),
    stats: withUnavailableErrors(createStatsRepository(database)),
    notifications: withUnavailableErrors(createNotificationRepository(database)),
    meta: withUnavailableErrors(createMetaRepository(database)),
    seed: withUnavailableErrors(createSeedRepository(database)),
    async ping() {
      await sql`SELECT 1`.execute(database.db);
    },
  });
}

/** Delete every row of every table, children first (tests). One atomic batch. */
export async function resetDatabase(database: Database): Promise<void> {
  const tables = [...TABLES].reverse();
  await database.batch([
    ...tables.map((table) => database.db.deleteFrom(table)),
    ...(database.dialect === "postgres" ? [] : [database.db.deleteFrom("search_fts")]),
  ]);
}
