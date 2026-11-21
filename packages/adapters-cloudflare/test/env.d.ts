// Bindings configured in vitest.config.ts (miniflare options).
declare namespace Cloudflare {
  interface Env {
    CACHE: KVNamespace;
    MEDIA: R2Bucket;
    LIMITS: DurableObjectNamespace<import("../src/index.ts").RateLimiterObject>;
    STREAMS: DurableObjectNamespace<import("../src/index.ts").StreamGateObject>;
    JOBS: Queue;
  }
}
