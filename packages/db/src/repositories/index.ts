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
import { createAdminRepository } from "./areas/admin.ts";
import { createBillingRepository } from "./areas/billing.ts";
import { createEventsRepository } from "./areas/events.ts";
import { createExperimentsRepository } from "./areas/experiments.ts";
import { createIdentityRepository } from "./areas/identity.ts";
import { createPersonalisationRepository } from "./areas/personalisation.ts";
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
    // Milestone 2: one repository per area (repositories/areas/<area>.ts).
    identity: withUnavailableErrors(createIdentityRepository(database)),
    billing: withUnavailableErrors(createBillingRepository(database)),
    events: withUnavailableErrors(createEventsRepository(database)),
    personalisation: withUnavailableErrors(createPersonalisationRepository(database)),
    experiments: withUnavailableErrors(createExperimentsRepository(database)),
    admin: withUnavailableErrors(createAdminRepository(database)),
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
