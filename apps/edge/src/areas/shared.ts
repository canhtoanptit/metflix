import {
  type BlobStore,
  type Clock,
  ConfigError,
  type IdGenerator,
  type Logger,
} from "@webflix/core";
import type { EdgeConfig, Env } from "../env.ts";

/** What an area's composition receives in the Worker (once per isolate). */
export interface AreaContext {
  env: Env;
  config: EdgeConfig;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  /** R2 (through the edge cache when enabled): the event lake lives in it. */
  blobs: BlobStore;
}

/** An adapter the configuration names but its area has not built yet: fail composing. */
export function notBuiltYet(variable: string, value: string, area: string): never {
  throw new ConfigError([`${variable}=${value}: not implemented yet (the ${area} area builds it)`]);
}
