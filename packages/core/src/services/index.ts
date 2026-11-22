import { type AreaServices, createAreaServices } from "../areas/index.ts";
import type { AreaSeams } from "../areas/module.ts";
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

/** Every application service, wired to one set of ports (milestone 2's areas included). */
export interface Services extends AreaServices {
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
  /** What the areas offer each other (server events, experiment assignments). */
  seams: AreaSeams;
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
  const { areas, seams } = createAreaServices(deps);
  const account = createAccountService(deps);
  const browse = createBrowseService(deps, state, {
    serving: areas.personalisation.serving,
    // Experiment targeting by plan or tenure reads the account through billing's service, and
    // only while a running experiment targets them.
    memberFacts: async (accountId) => {
      const details = await account.getAccount(accountId);
      return { plan: details.plan.id, joinedAt: Date.parse(details.account.createdAt) };
    },
  });
  const modules = Object.values(areas);
  return {
    ...areas,
    seams,
    auth: createAuthService(deps, seams),
    account,
    profiles: createProfileService(deps),
    browse,
    search: createSearchService(deps, browse.personalizeAvailable),
    library: createLibraryService(deps, state, browse.personalize),
    // Playback refuses what staff made unavailable, like the detail page (editorial is cached).
    playback: createPlaybackService(deps, browse.personalizeAvailable),
    seeder: createSeeder(deps, state),
    scheduler: createScheduler(deps, modules),
    // Jobs that exhaust their attempts are also recorded for staff (admin area, dead letters).
    processor: areas.admin.captureDeadLetters(
      createProcessor(
        deps,
        state,
        modules.flatMap((module) => module.jobs),
      ),
    ),
    state,
  };
}
