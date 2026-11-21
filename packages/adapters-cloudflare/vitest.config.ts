import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside workerd (the Workers runtime), not Node: every adapter in this package
 * passes its @webflix/core contract suite here, against miniflare's implementations of KV, R2,
 * SQLite-backed Durable Objects and Queues. `test/worker.ts` is the Worker that exports the
 * Durable Object classes and the queue consumer.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-11-19",
        kvNamespaces: ["CACHE"],
        r2Buckets: ["MEDIA"],
        durableObjects: {
          LIMITS: { className: "RateLimiterObject", useSQLite: true },
          STREAMS: { className: "StreamGateObject", useSQLite: true },
        },
        queueProducers: { JOBS: { queueName: "contract-jobs" } },
        queueConsumers: {
          // Mirrors production (max_retries 4 → 5 attempts, dead-letter queue) with no batching
          // wait and no default retry delay, so the suite runs in seconds.
          "contract-jobs": {
            maxBatchSize: 10,
            maxBatchTimeout: 0,
            maxRetries: 4,
            retryDelay: 0,
            deadLetterQueue: "contract-jobs-dlq",
          },
          "contract-jobs-dlq": { maxBatchSize: 10, maxBatchTimeout: 0 },
        },
      },
    }),
  ],
  test: {
    // Queue deliveries are real (asynchronous, batched by miniflare).
    testTimeout: 30_000,
  },
});
