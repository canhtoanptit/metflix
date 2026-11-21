/**
 * @webflix/adapters-node/valkey: shared state for the k8s mode (several API replicas and a
 * worker). Every adapter passes its `@webflix/core/testing` contract suite against a real
 * Valkey (see `test/valkey.test.ts`).
 */
export { createValkeyCache } from "./cache.ts";
export {
  connectValkey,
  guarded,
  isUnavailable,
  type ValkeyConnection,
  type ValkeyOptions,
} from "./connection.ts";
export {
  createValkeyJobQueue,
  type JobQueueStats,
  type ValkeyJobQueue,
  type ValkeyJobQueueOptions,
} from "./job-queue.ts";
export { createValkeyRateLimiter, type ValkeyRateLimiterOptions } from "./rate-limiter.ts";
export { createValkeyStreamGate, type ValkeyStreamGateOptions } from "./stream-gate.ts";
