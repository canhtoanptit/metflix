/**
 * @webflix/core/memory: in-process implementations of every stateful port. Used by dev mode
 * and tests, and the reference behaviour each contract suite was written against.
 */
export { createMemoryAreaPorts, type MemoryAreaPorts } from "./area-ports.ts";
export { MemoryBlobStore } from "./blob-store.ts";
export { MemoryKeyValueCache } from "./cache.ts";
export { MemoryEmailSender } from "./email-sender.ts";
export { MemoryEventSink } from "./event-sink.ts";
export { MemoryExperiments } from "./experiments.ts";
export {
  type MemoryIdentityFault,
  MemoryIdentityProvider,
  type MemorySignIn,
} from "./identity-provider.ts";
export { MemoryJobQueue, type MemoryJobQueueOptions } from "./job-queue.ts";
export { MemoryPaymentProvider } from "./payment-provider.ts";
export { MemoryRateLimiter } from "./rate-limiter.ts";
export { MemoryRecommendationStore } from "./recommendation-store.ts";
export { createMemoryRepositories, MemoryStore } from "./repositories.ts";
export { MemorySearchIndex } from "./search-index.ts";
export { type MemoryStaffToken, MemoryStaffVerifier } from "./staff-verifier.ts";
export { MemoryStreamGate } from "./stream-gate.ts";
