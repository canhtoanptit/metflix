/**
 * `@webflix/adapters-cloudflare/storage`: the adapters that only need a binding object, with no
 * `cloudflare:workers` import. Node tooling uses them on `getPlatformProxy` bindings (local
 * miniflare state or, with remote bindings, the real account): seeding D1 and KV, uploading
 * media to R2 through the same `BlobStore` the Worker reads with, and importing a
 * recommendation run from outside the Worker (lists through the KV REST bulk API in production).
 */
export { createKvCache } from "./kv-cache.ts";
export { createQueuesJobQueue } from "./queues.ts";
export { createR2BlobStore } from "./r2-blob-store.ts";
export {
  bindingBulkWriter,
  createKvRecommendationStore,
  createKvRestBulkWriter,
  type KvBulkWriter,
  type KvPair,
} from "./recommendation-store.ts";
