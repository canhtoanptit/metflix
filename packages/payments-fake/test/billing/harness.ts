import {
  type AuthContext,
  createHmacTokenSigner,
  createMediaTokens,
  createMockBillingProvider,
  createPbkdf2PasswordHasher,
  createServices,
  createUuidV7Generator,
  loadCoreConfig,
  type Repositories,
  type ServiceDependencies,
  type Services,
} from "@webflix/core";
import {
  createMemoryAreaPorts,
  createMemoryRepositories,
  MemoryJobQueue,
  MemoryKeyValueCache,
  MemorySearchIndex,
  MemoryStreamGate,
} from "@webflix/core/memory";
import { ManualClock, MemoryLogger } from "@webflix/core/testing";
import type { FakeTestCard } from "../../src/cards.ts";
import { FakePaymentProvider, type FakePaymentProviderOptions } from "../../src/provider.ts";
import { type FakeStore, MemoryFakeStore } from "../../src/store.ts";
import { TEST_WEBHOOK_SECRET } from "../harness.ts";

/** 2026-11-22T12:00:00Z. */
export const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
export const DAY_MS = 24 * 3_600_000;

export interface BillingHarness {
  services: Services;
  deps: ServiceDependencies;
  repos: Repositories;
  fake: FakePaymentProvider;
  clock: ManualClock;
  queue: MemoryJobQueue;
  logger: MemoryLogger;
  /** A new account without a membership (milestone 2 sign-up: no card), at the profile gate. */
  account(email?: string): Promise<AuthContext>;
  /** Processes every queued job (webhook events). */
  drain(): Promise<void>;
  /** The browser's part: confirm a client secret in the fake's form (challenges completed). */
  confirm(clientSecret: string | null, card: FakeTestCard | null): Promise<void>;
  /** Start + confirm the card + confirm the checkout (+ pay when asked): a member. */
  subscribe(
    auth: AuthContext,
    options?: {
      plan?: "basic" | "standard" | "premium";
      card?: FakeTestCard;
      payCard?: FakeTestCard;
    },
  ): Promise<{ checkoutId: string }>;
}

/**
 * The real billing service over in-memory repositories and the real fake provider, with one
 * manual clock for both (the fake's per-customer clocks still move on their own when advanced).
 * Webhooks go the way they go in every mode: the fake signs and delivers them, the service
 * verifies, records and queues them, `drain()` processes them.
 */
export async function createBillingHarness(
  options: {
    store?: FakeStore;
    fake?: Partial<FakePaymentProviderOptions>;
    config?: Record<string, string>;
    repos?: Repositories;
  } = {},
): Promise<BillingHarness> {
  const clock = new ManualClock(NOW);
  const logger = new MemoryLogger({ clock });
  const config = loadCoreConfig({
    WEBFLIX_MODE: "dev",
    WEBFLIX_ENV: "test",
    ...options.config,
  });
  const queue = new MemoryJobQueue({ clock, logger, maxAttempts: 3 });
  const ids = createUuidV7Generator({ clock });
  const fake = new FakePaymentProvider({
    store: options.store ?? new MemoryFakeStore(),
    webhookSecret: TEST_WEBHOOK_SECRET,
    clock,
    logger,
    ...options.fake,
  });
  const repos = options.repos ?? createMemoryRepositories();
  const deps: ServiceDependencies = {
    ...createMemoryAreaPorts({ clock, ids }),
    payments: fake,
    config,
    repos,
    search: new MemorySearchIndex(),
    cache: new MemoryKeyValueCache({ clock }),
    streamGate: new MemoryStreamGate({ clock }),
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
  let counter = 0;

  const harness: BillingHarness = {
    services,
    deps,
    repos,
    fake,
    clock,
    queue,
    logger,
    async account(email) {
      counter += 1;
      const id = `acct-${counter}-${crypto.randomUUID().slice(0, 8)}`;
      const now = clock.now();
      const session = {
        id: `ses-${id}`,
        tokenHash: `hash-${id}`,
        accountId: id,
        activeProfileId: null,
        deviceLabel: "Test",
        deviceType: "desktop" as const,
        persistent: true,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 30 * DAY_MS,
      };
      await repos.accounts.createWithSession({
        account: {
          id,
          email: email ?? `${id}@example.test`,
          passwordHash: "x",
          createdAt: now,
          updatedAt: now,
        },
        // What a sign-up without payment leaves (the identity area's): no card, no membership.
        subscription: {
          accountId: id,
          planId: "standard",
          startedAt: now,
          currentPeriodEnd: now,
          canceledAt: now,
          card: null,
          updatedAt: now,
        },
        session,
      });
      return { session, profile: null };
    },
    async drain() {
      for (let i = 0; i < 20 && queue.size > 0; i += 1) await queue.drain();
    },
    async confirm(clientSecret, card) {
      if (!clientSecret) throw new Error("nothing to confirm");
      const described = await fake.describeSecret(clientSecret);
      const outcome =
        described?.kind === "setup"
          ? await fake.confirmSetup(clientSecret, card, { challenge: "complete" })
          : await fake.confirmPayment(clientSecret, card, { challenge: "complete" });
      if (outcome.status !== "succeeded") throw new Error(`confirmation ${outcome.status}`);
    },
    async subscribe(auth, subscribeOptions = {}) {
      const started = await services.billing.startCheckout(auth, {
        planId: subscribeOptions.plan ?? "standard",
      });
      await harness.confirm(started.clientSecret, subscribeOptions.card ?? "visa");
      const confirmed = await services.billing.confirmCheckout(auth.session.accountId, started.id);
      if (confirmed.status === "requires_payment") {
        await harness.confirm(confirmed.clientSecret, subscribeOptions.payCard ?? null);
      }
      await harness.drain();
      return { checkoutId: started.id };
    },
  };
  return harness;
}
