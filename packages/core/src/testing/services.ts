import type {
  CatalogSeed,
  Checkout,
  DemoAccountSeed,
  MediaManifest,
  PlanId,
} from "@webflix/contracts";
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
import type { PaymentTestCard } from "../ports/payment-provider.ts";
import type { SearchIndex } from "../ports/search-index.ts";
import { createHmacTokenSigner, createMediaTokens } from "../ports/token-signer.ts";
import type { Repositories } from "../repositories/ports.ts";
import type { AuthContext, ServiceDependencies } from "../services/context.ts";
import { createServices, type Services } from "../services/index.ts";
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
 * Services over in-memory ports with a manual clock and cheap password hashing: the harness for
 * service unit tests and HTTP integration tests.
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

/**
 * Makes `auth`'s account a member the one way a member account comes about (§5.1): a checkout
 * at the payment provider (here the in-memory one, its card confirmed the way the browser's form
 * would). The first account to use a card gets a trial; a card whose trial was used pays the
 * first invoice at once. Answers the completed checkout.
 */
export async function subscribeForTest(
  t: Pick<TestServices, "services" | "ports">,
  auth: AuthContext,
  options: { plan?: PlanId; card?: PaymentTestCard } = {},
): Promise<Checkout> {
  const accountId = auth.session.accountId;
  const card = options.card ?? "visa";
  const started = await t.services.billing.startCheckout(auth, {
    planId: options.plan ?? "standard",
  });
  await t.ports.payments.confirmSetup(started.clientSecret ?? "", card);
  let checkout = await t.services.billing.confirmCheckout(accountId, started.id);
  if (checkout.status === "requires_payment") {
    await t.ports.payments.confirmPayment(checkout.clientSecret ?? "", card);
    checkout = await t.services.billing.getCheckout(accountId, started.id);
  }
  if (checkout.status !== "complete") throw new Error(`checkout ended ${checkout.status}`);
  return checkout;
}
