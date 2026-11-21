/**
 * @webflix/core/testing: reusable contract suites, one per port. Every adapter must pass the
 * suite for its port, in the runtime it ships to (Node for adapters-node, workerd for
 * adapters-cloudflare). Imports vitest; never import this from production code.
 *
 * ```ts
 * describeBlobStoreContract("filesystem", async () => {
 *   const root = await mkdtemp(...);
 *   return { store: createFsBlobStore({ root }), cleanup: () => rm(root, { recursive: true }) };
 * });
 * ```
 */
export { ManualClock } from "../ports/clock.ts";
export { MemoryLogger } from "../ports/logger.ts";
export { type BlobStoreHarness, describeBlobStoreContract } from "./blob-store.contract.ts";
export { describeKeyValueCacheContract, type KeyValueCacheHarness } from "./cache.contract.ts";
export * from "./fixture-catalog.ts";
export {
  bytesOf,
  type HarnessBase,
  type HarnessFactory,
  readAll,
  type TimeControl,
  useHarness,
} from "./harness.ts";
export {
  describeJobQueueContract,
  type JobQueueHarness,
  type JobQueueHarnessFactory,
} from "./job-queue.contract.ts";
export {
  describePasswordHasherContract,
  type PasswordHasherHarness,
} from "./password-hasher.contract.ts";
export { describeRateLimiterContract, type RateLimiterHarness } from "./rate-limiter.contract.ts";
export * from "./records.ts";
export {
  describeRepositoryContract,
  type RepositoryHarness,
} from "./repositories.contract.ts";
export {
  describeSearchIndexContract,
  SEARCH_CONTRACT_CORPUS,
  type SearchIndexHarness,
} from "./search-index.contract.ts";
export {
  createTestServices,
  TEST_NOW,
  type TestServices,
  type TestServicesOptions,
} from "./services.ts";
export { describeStreamGateContract, type StreamGateHarness } from "./stream-gate.contract.ts";
export { describeTokenSignerContract, type TokenSignerHarness } from "./token-signer.contract.ts";
