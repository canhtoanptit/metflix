import { CatalogCache, PopularityCache, ShowcaseCache } from "../catalog/cache.ts";
import type { JobProcessor } from "../ports/job-queue.ts";
import { type AccountService, createAccountService } from "./account.ts";
import { type AuthService, createAuthService } from "./auth.ts";
import { type BrowseService, createBrowseService } from "./browse.ts";
import type { ServiceDependencies, ServiceState } from "./context.ts";
import { createProcessor, createScheduler, type Scheduler } from "./jobs.ts";
import { createLibraryService, type LibraryService } from "./library.ts";
import { createPlaybackService, type PlaybackService } from "./playback.ts";
import { createProfileService, type ProfileService } from "./profiles.ts";
import { createSearchService, type SearchService } from "./search.ts";
import { createSeeder, type Seeder } from "./seed.ts";

/** Every application service, wired to one set of ports. */
export interface Services {
  auth: AuthService;
  account: AccountService;
  profiles: ProfileService;
  browse: BrowseService;
  search: SearchService;
  library: LibraryService;
  playback: PlaybackService;
  seeder: Seeder;
  /** Publishes periodic jobs; call `tick()` from a timer or a Cron Trigger. */
  scheduler: Scheduler;
  /** Consumes jobs; hand it to the `JobQueue` adapter (memory, Valkey Streams, Queues). */
  processor: JobProcessor;
  state: ServiceState;
}

/**
 * Build the services from ports. Portable: the same call runs in the Node API, the Node
 * worker and the Worker (`apps/edge`). Construction does no I/O.
 */
export function createServices(deps: ServiceDependencies): Services {
  const catalog = new CatalogCache({
    repository: deps.repos.catalog,
    cache: deps.cache,
    clock: deps.clock,
    logger: deps.logger,
  });
  const state: ServiceState = {
    catalog,
    popularity: new PopularityCache({
      repository: deps.repos.stats,
      cache: deps.cache,
      clock: deps.clock,
      logger: deps.logger,
    }),
    showcase: new ShowcaseCache({
      catalog,
      cache: deps.cache,
      clock: deps.clock,
      logger: deps.logger,
    }),
  };
  const browse = createBrowseService(deps, state);
  return {
    auth: createAuthService(deps),
    account: createAccountService(deps),
    profiles: createProfileService(deps),
    browse,
    search: createSearchService(deps, browse.personalize),
    library: createLibraryService(deps, state, browse.personalize),
    playback: createPlaybackService(deps, browse.personalize),
    seeder: createSeeder(deps, state),
    scheduler: createScheduler(deps),
    processor: createProcessor(deps, state),
    state,
  };
}
