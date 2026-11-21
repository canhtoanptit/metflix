import {
  createHmacTokenSigner,
  createPasswordHasherChain,
  createPbkdf2PasswordHasher,
  ManualClock,
  scopeBlobStore,
} from "../src/index.ts";
import {
  createMemoryRepositories,
  MemoryBlobStore,
  MemoryJobQueue,
  MemoryKeyValueCache,
  MemoryRateLimiter,
  MemorySearchIndex,
  MemoryStreamGate,
} from "../src/memory/index.ts";
import {
  describeBlobStoreContract,
  describeJobQueueContract,
  describeKeyValueCacheContract,
  describePasswordHasherContract,
  describeRateLimiterContract,
  describeRepositoryContract,
  describeSearchIndexContract,
  describeStreamGateContract,
  describeTokenSignerContract,
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
