/**
 * Main module of the test Worker: it exports the Durable Object classes (the runtime
 * instantiates them from here) and a `queue()` handler, so the job queue contract runs against
 * miniflare's real Queues implementation: delivery, retries with delays and dead-lettering.
 *
 * The contract harness installs the processor at run time through `globalThis` (tests and this
 * module share the isolate, but not necessarily one module instance).
 */
import { createQueueConsumer } from "../src/index.ts";
import type { QueueTestHooks } from "./queue-hooks.ts";

export { RateLimiterObject, StreamGateObject } from "../src/index.ts";

function hooks(): QueueTestHooks | undefined {
  return (globalThis as { __webflixQueueHooks?: QueueTestHooks }).__webflixQueueHooks;
}

export default {
  async fetch() {
    return new Response("adapters-cloudflare test worker");
  },
  async queue(batch) {
    const current = hooks();
    if (!current) {
      // A message from an earlier test file (no harness installed): settle it quietly.
      batch.ackAll();
      return;
    }
    if (batch.queue === current.deadLetterQueue) {
      for (const message of batch.messages) current.onDeadLetter(message);
      batch.ackAll();
      return;
    }
    await createQueueConsumer(current.processor, { maxAttempts: current.maxAttempts })(batch);
  },
} satisfies ExportedHandler;
