/**
 * @webflix/adapters-cloudflare: `@webflix/core` ports on Cloudflare bindings. Every adapter
 * passes its core contract suite inside workerd (`vitest.config.ts` runs the tests in the
 * Workers runtime, on miniflare's implementations of the bindings).
 *
 * | Port | Binding |
 * | --- | --- |
 * | `KeyValueCache` | Workers KV (`createKvCache`) |
 * | `BlobStore` | R2 (`createR2BlobStore`) |
 * | `RateLimiter` | Durable Object per `policy:key` (`RateLimiterObject`) |
 * | `StreamGate` | Durable Object per account (`StreamGateObject`) |
 * | `JobQueue` | Queues producer + `queue()` consumer (`createQueuesJobQueue`, `createQueueConsumer`) |
 * | `RecommendationStore` | KV for per-profile lists over the D1 store (`createKvRecommendationStore`) |
 *
 * The Durable Object classes must be exported from the Worker's main module.
 */

export {
  type BlobOrigin,
  type BlobOriginOptions,
  blobKeyFromOriginPath,
  createEdgeCachedBlobStore,
  type EdgeCachedBlobStoreOptions,
  serveBlobOrigin,
} from "./edge-cached-blob-store.ts";
export { createKvCache } from "./kv-cache.ts";
export {
  createQueueConsumer,
  createQueuesJobQueue,
  type QueueConsumerOptions,
} from "./queues.ts";
export { createR2BlobStore } from "./r2-blob-store.ts";
export {
  createDurableObjectRateLimiter,
  type DurableObjectRateLimiterOptions,
  RateLimiterObject,
} from "./rate-limiter.ts";
export {
  bindingBulkWriter,
  createKvRecommendationStore,
  createKvRestBulkWriter,
  KV_BINDING_LISTS_PER_IMPORT,
  KV_REST_BULK_MAX_BYTES,
  KV_REST_BULK_MAX_PAIRS,
  type KvBulkWriter,
  type KvPair,
  type KvRecommendationStoreOptions,
  type KvRestBulkWriterOptions,
} from "./recommendation-store.ts";
export {
  createDurableObjectStreamGate,
  type DurableObjectStreamGateOptions,
  StreamGateObject,
} from "./stream-gate.ts";
