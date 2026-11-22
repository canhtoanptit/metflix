import type { EventsRepository } from "@webflix/core";
import type { Database } from "../../database.ts";

/**
 * The events area's repository on every dialect (SQLite, PostgreSQL, D1), over its tables
 * (`tables/events.ts`). Empty until the events owner adds methods; each must pass
 * `describeEventsRepositoryContract` here and in workerd.
 */
export function createEventsRepository(_database: Database): EventsRepository {
  return {};
}
