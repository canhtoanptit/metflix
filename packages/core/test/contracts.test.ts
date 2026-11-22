import {
  createBlobLakeEventSink,
  createHmacTokenSigner,
  createPasswordHasherChain,
  createPbkdf2PasswordHasher,
  createUuidV7Generator,
  decodeLakeObject,
  ManualClock,
  scopeBlobStore,
} from "../src/index.ts";
import {
  createMemoryRepositories,
  MemoryBlobStore,
  MemoryEmailSender,
  MemoryEventSink,
  MemoryExperiments,
  MemoryIdentityProvider,
  MemoryJobQueue,
  MemoryKeyValueCache,
  MemoryPaymentProvider,
  MemoryRateLimiter,
  MemoryRecommendationStore,
  MemorySearchIndex,
  MemoryStaffVerifier,
  MemoryStreamGate,
} from "../src/memory/index.ts";
import {
  describeAdminRepositoryContract,
  describeBillingRepositoryContract,
  describeBlobStoreContract,
  describeEmailSenderContract,
  describeEventSinkContract,
  describeEventsRepositoryContract,
  describeExperimentsContract,
  describeExperimentsRepositoryContract,
  describeIdentityProviderContract,
  describeIdentityRepositoryContract,
  describeJobQueueContract,
  describeKeyValueCacheContract,
  describePasswordHasherContract,
  describePaymentProviderContract,
  describePersonalisationRepositoryContract,
  describeRateLimiterContract,
  describeRecommendationStoreContract,
  describeRepositoryContract,
  describeSearchIndexContract,
  describeStaffVerifierContract,
  describeStreamGateContract,
  describeTokenSignerContract,
  readAll,
} from "../src/testing/index.ts";

const timed = <T>(create: (clock: ManualClock) => T) => {
  const clock = new ManualClock();
  return { clock, subject: create(clock), time: { advance: (ms: number) => clock.advance(ms) } };
};

describeKeyValueCacheContract("memory", () => {
  const { subject, time } = timed((clock) => new MemoryKeyValueCache({ clock }));
  return { cache: subject, time };
});

describeRateLimiterContract("memory (GCRA)", () => {
  const { subject, time } = timed((clock) => new MemoryRateLimiter({ clock }));
  return { limiter: subject, time };
});

describeStreamGateContract("memory", () => {
  const { subject, time } = timed((clock) => new MemoryStreamGate({ clock }));
  return { gate: subject, time };
});

describeBlobStoreContract("memory", () => ({ store: new MemoryBlobStore() }));

describeBlobStoreContract("memory, scoped under a prefix", () => {
  const backing = new MemoryBlobStore();
  // Noise outside the scope must stay invisible to it.
  void backing.put("other/a/b", "noise");
  return { store: scopeBlobStore(backing, "tenant-1/contract") };
});

describeJobQueueContract("memory", (processor) => {
  const clock = new ManualClock();
  const queue = new MemoryJobQueue({ processor, clock, maxAttempts: 4 });
  return {
    queue,
    drain: () => queue.drain(),
    deadLetters: () => queue.deadLetters,
    maxAttempts: 4,
    time: { advance: (ms) => clock.advance(ms) },
  };
});

describeSearchIndexContract("memory", () => ({ index: new MemorySearchIndex() }));

describePasswordHasherContract("pbkdf2-sha256 (WebCrypto)", () => ({
  hasher: createPbkdf2PasswordHasher({ iterations: 1_000 }),
}));

describePasswordHasherContract("chain: pbkdf2 primary + legacy pbkdf2", () => ({
  hasher: createPasswordHasherChain(
    createPbkdf2PasswordHasher({ iterations: 2_000 }),
    createPbkdf2PasswordHasher({ iterations: 1_000 }),
  ),
}));

describeTokenSignerContract("hmac-sha256 (WebCrypto)", () => {
  const clock = new ManualClock(Date.UTC(2026, 5, 1));
  const keys = [
    { id: "k2", secret: "s".repeat(32) },
    { id: "k1", secret: "t".repeat(32) },
  ];
  return {
    signer: createHmacTokenSigner({ keys, clock }),
    foreignSigner: createHmacTokenSigner({ keys: [{ id: "zz", secret: "u".repeat(32) }], clock }),
    now: () => clock.now(),
    time: { advance: (ms) => clock.advance(ms) },
  };
});

describeRepositoryContract("memory", () => ({ repos: createMemoryRepositories() }));

// --- Milestone 2 ports ----------------------------------------------------------------------------

describeIdentityProviderContract("memory", () => {
  const provider = new MemoryIdentityProvider({ id: "google", clock: new ManualClock() });
  return {
    provider,
    redirectUri: "https://webflix.test/api/v1/auth/oidc/google/callback",
    signIn: async (url, signIn) => provider.complete(url, signIn),
  };
});

describeStaffVerifierContract("memory", () => {
  const clock = new ManualClock();
  const verifier = new MemoryStaffVerifier({ clock });
  const impostor = new MemoryStaffVerifier({ clock });
  return {
    verifier,
    mint: (request) => verifier.mint(request),
    forge: (request) => impostor.mint(request),
  };
});

describeEmailSenderContract("memory", () => {
  const sender = new MemoryEmailSender({ clock: new ManualClock() });
  return { sender, delivered: async (to) => sender.mailbox(to) };
});

describeEventSinkContract("memory", () => {
  const sink = new MemoryEventSink();
  return { sink, readBack: async () => sink.objects() };
});

describeEventSinkContract("lake writer over a memory blob store", () => {
  const blobs = new MemoryBlobStore();
  const sink = createBlobLakeEventSink({ blobs, ids: createUuidV7Generator() });
  return {
    sink,
    async readBack() {
      const { items } = await blobs.list({ prefix: "events/" });
      return Promise.all(
        items.map(async (item) => {
          const object = await blobs.get(item.key);
          if (!object) throw new Error(`${item.key} vanished`);
          return { key: item.key, events: await decodeLakeObject(await readAll(object.body)) };
        }),
      );
    },
  };
});

describeRecommendationStoreContract("memory", () => ({ store: new MemoryRecommendationStore() }));

describeExperimentsContract("memory", () => {
  const experiments = new MemoryExperiments();
  return { experiments, define: async (definitions) => experiments.set(definitions) };
});

describePaymentProviderContract("memory", async () => {
  const provider = new MemoryPaymentProvider({
    clock: new ManualClock(Date.UTC(2026, 10, 22, 12)),
  });
  const prices = {
    basic: {
      lookupKey: "webflix.basic.monthly.usd",
      productId: "webflix_basic",
      productName: "Basic",
      amountMinor: 799,
      currency: "USD",
    },
    premium: {
      lookupKey: "webflix.premium.monthly.usd",
      productId: "webflix_premium",
      productName: "Premium",
      amountMinor: 1999,
      currency: "USD",
    },
  };
  await provider.syncCatalogue([prices.basic, prices.premium]);
  return {
    provider,
    prices,
    confirmSetup: async (setup, card) => {
      await provider.confirmSetup(setup.clientSecret ?? "", card);
    },
    confirmPayment: async (subscription, card) => {
      await provider.confirmPayment(subscription.paymentClientSecret ?? "", card);
    },
    createPromotion: async (input) => provider.definePromotion(input),
    webhook: async (options) => {
      const [event] = await provider.listEvents({ createdAfter: 0, limit: 1 });
      const sample = event ?? {
        id: "evt_sample",
        type: "customer.created",
        createdAt: 0,
        customerId: null,
        subscriptionId: null,
        invoiceId: null,
        setupId: null,
        idempotencyKey: null,
      };
      return { ...(await provider.signedDelivery(sample, options)), id: sample.id };
    },
  };
});

// --- Milestone 2 area repositories (each area adds its cases to its own suite) ----------------

for (const describeArea of [
  describeIdentityRepositoryContract,
  describeBillingRepositoryContract,
  describeEventsRepositoryContract,
  describePersonalisationRepositoryContract,
  describeExperimentsRepositoryContract,
  describeAdminRepositoryContract,
]) {
  describeArea("memory", () => ({ repos: createMemoryRepositories() }));
}
