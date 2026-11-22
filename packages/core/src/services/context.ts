import type { AreaPorts } from "../areas/ports.ts";
import type { CatalogCache, PopularityCache, ShowcaseCache } from "../catalog/cache.ts";
import type { CoreConfig } from "../config.ts";
import type { KeyValueCache } from "../ports/cache.ts";
import type { Clock } from "../ports/clock.ts";
import type { IdGenerator } from "../ports/ids.ts";
import type { JobQueue } from "../ports/job-queue.ts";
import type { Logger } from "../ports/logger.ts";
import type { PasswordHasher } from "../ports/password-hasher.ts";
import type { SearchIndex } from "../ports/search-index.ts";
import type { StreamGate } from "../ports/stream-gate.ts";
import type { MediaTokens } from "../ports/token-signer.ts";
import type { Repositories } from "../repositories/ports.ts";
import type { ProfileRecord, SessionRecord } from "../repositories/records.ts";

/**
 * Everything the application services need: ports only, no runtime or driver. Milestone 2's
 * ports come from `AreaPorts` (in-memory by default: `createMemoryAreaPorts`).
 */
export interface ServiceDependencies extends AreaPorts {
  config: CoreConfig;
  repos: Repositories;
  search: SearchIndex;
  /** Shared, eventually consistent cache (catalog snapshot, popularity). */
  cache: KeyValueCache;
  streamGate: StreamGate;
  jobs: JobQueue;
  passwords: PasswordHasher;
  mediaTokens: MediaTokens;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
}

/** Shared state built once per container (not per request). */
export interface ServiceState {
  catalog: CatalogCache;
  popularity: PopularityCache;
  showcase: ShowcaseCache;
}

/** An authenticated request: the device session and its active profile, if any. */
export interface AuthContext {
  session: SessionRecord;
  profile: ProfileRecord | null;
}

/** An authenticated request with an active profile (`auth: "profile"` routes). */
export interface Viewer {
  session: SessionRecord;
  profile: ProfileRecord;
}

/** What the HTTP layer knows about the client device. */
export interface ClientInfo {
  userAgent: string | null;
}
