import type { CatalogSeed, DemoAccountSeed, MediaManifest } from "@webflix/contracts";
import { type CoreConfig, loadCoreConfig } from "../config.ts";
import { createMemoryAreaPorts, type MemoryAreaPorts } from "../memory/area-ports.ts";
import { MemoryKeyValueCache } from "../memory/cache.ts";
import { MemoryJobQueue } from "../memory/job-queue.ts";
import { createMemoryRepositories } from "../memory/repositories.ts";
import { MemorySearchIndex } from "../memory/search-index.ts";
import { MemoryStreamGate } from "../memory/stream-gate.ts";
import { ManualClock } from "../ports/clock.ts";
import { createUuidV7Generator } from "../ports/ids.ts";
import { MemoryLogger } from "../ports/logger.ts";
import { createPbkdf2PasswordHasher } from "../ports/password-hasher.ts";
import type { SearchIndex } from "../ports/search-index.ts";
import { createHmacTokenSigner, createMediaTokens } from "../ports/token-signer.ts";
import type { Repositories } from "../repositories/ports.ts";
import type { ServiceDependencies } from "../services/context.ts";
import { createServices, type Services } from "../services/index.ts";
import { createMockBillingProvider } from "../services/subscriptions.ts";
import { FIXTURE_CATALOG, FIXTURE_DEMO_ACCOUNT, FIXTURE_MANIFEST } from "./fixture-catalog.ts";

/** 2026-06-15T12:00:00Z: a fixed "now" so relative seed times and stats are reproducible. */
export const TEST_NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

export interface TestServices {
  services: Services;
  deps: ServiceDependencies;
  /** Milestone 2's ports, in memory, with their test handles (mailbox, fake provider...). */
  ports: MemoryAreaPorts;
  clock: ManualClock;
  queue: MemoryJobQueue;
  gate: MemoryStreamGate;
  logger: MemoryLogger;
}

export interface TestServicesOptions {
  repos?: Repositories;
  /** Defaults to an in-memory index. */
  search?: SearchIndex;
  config?: Partial<Record<string, string>>;
  /** Seed with the fixture catalog (default) or the given data; `false` for an empty database. */
  seed?:
    | false
    | {
        catalog: CatalogSeed;
        demoAccount?: DemoAccountSeed | null;
        manifest?: MediaManifest | null;
      };
  now?: number;
}

/**
 * Services over in-memory ports with a manual clock, cheap password hashing and the mock
 * billing provider: the harness for service unit tests and HTTP integration tests.
 */
export async function createTestServices(options: TestServicesOptions = {}): Promise<TestServices> {
  const clock = new ManualClock(options.now ?? TEST_NOW);
  const logger = new MemoryLogger({ clock });
  const config: CoreConfig = loadCoreConfig({
    WEBFLIX_MODE: "dev",
    WEBFLIX_ENV: "test",
    ...options.config,
  });
  const queue = new MemoryJobQueue({ clock, logger });
  const gate = new MemoryStreamGate({ clock });
  const ids = createUuidV7Generator({ clock });
  const ports = createMemoryAreaPorts({ clock, ids });
  const deps: ServiceDependencies = {
    ...ports,
    config,
    repos: options.repos ?? createMemoryRepositories(),
    search: options.search ?? new MemorySearchIndex(),
    cache: new MemoryKeyValueCache({ clock }),
    streamGate: gate,
    jobs: queue,
    passwords: createPbkdf2PasswordHasher({ iterations: 1_000 }),
    mediaTokens: createMediaTokens(
      createHmacTokenSigner({ keys: config.media.tokenKeys, clock }),
      clock,
    ),
    billing: createMockBillingProvider(),
    clock,
    ids,
    logger,
  };
  const services = createServices(deps);
  queue.setProcessor(services.processor);
  if (options.seed !== false) {
    await services.seeder.seed(
      options.seed ?? {
        catalog: FIXTURE_CATALOG,
        demoAccount: FIXTURE_DEMO_ACCOUNT,
        manifest: FIXTURE_MANIFEST,
      },
    );
  }
  return { services, deps, ports, clock, queue, gate, logger };
}
