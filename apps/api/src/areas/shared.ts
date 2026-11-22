import {
  type BlobStore,
  type Clock,
  ConfigError,
  type IdGenerator,
  type KeyValueCache,
  type Logger,
} from "@webflix/core";
import type { Database } from "@webflix/db";
import type { ApiConfig } from "../config.ts";

/** What an area's composition receives in the Node runtime (dev and k8s). */
export interface AreaContext {
  config: ApiConfig;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  /** The mode's blob store (filesystem in dev, S3 on k8s): the event lake lives in it. */
  blobs: BlobStore;
  /** The mode's database (SQLite in dev, PostgreSQL on k8s), for area adapters on SQL. */
  database: Database;
  /** The shared cache (Valkey when configured, else in process). */
  cache: KeyValueCache;
}

/** An adapter the configuration names but its area has not built yet: fail at startup. */
export function notBuiltYet(variable: string, value: string, area: string): never {
  throw new ConfigError([`${variable}=${value}: not implemented yet (the ${area} area builds it)`]);
}
