/**
 * The Queues `JobQueue` against miniflare's real Queues: jobs go through the producer binding,
 * are delivered in batches to the test Worker's `queue()` handler (`test/worker.ts`), which
 * runs `createQueueConsumer`; retries are real redeliveries and exhausted jobs really land in
 * the dead-letter queue. Nothing is simulated except time: Queues' clock cannot be driven, so
 * the delayed-delivery case is covered separately with a real (short) delay.
 */
import { env } from "cloudflare:workers";
import type { JobDelivery, JobProcessor, JobQueue } from "@webflix/core";
import { describeJobQueueContract } from "@webflix/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createQueuesJobQueue } from "../src/index.ts";
import { installQueueHooks } from "./queue-hooks.ts";

const MAX_ATTEMPTS = 5; // vitest.config.ts: maxRetries 4
const DEAD_LETTER_QUEUE = "contract-jobs-dlq";

interface Tracker {
  queue: JobQueue;
  drain(): Promise<void>;
  deadLetters: JobDelivery[];
}

/** Count what was published and what has settled (acknowledged or dead-lettered). */
function track(processor: JobProcessor): Tracker {
  let published = 0;
  let acknowledged = 0;
  const deadLetters: JobDelivery[] = [];
  const inner = createQueuesJobQueue(env.JOBS);
  installQueueHooks({
    maxAttempts: MAX_ATTEMPTS,
    deadLetterQueue: DEAD_LETTER_QUEUE,
    processor: async (delivery) => {
      const outcome = await processor(delivery);
      if (outcome.action === "ack") acknowledged += 1;
      return outcome;
    },
    onDeadLetter(message) {
      const body = message.body as { type: string; payload: never };
      deadLetters.push({
        id: message.id,
        type: body.type,
        payload: body.payload,
        attempt: message.attempts,
        enqueuedAt: message.timestamp.getTime(),
      });
    },
  });
  return {
    deadLetters,
    queue: {
      async publish(job, options) {
        await inner.publish(job, options);
        published += 1;
      },
      async publishBatch(jobs, options) {
        await inner.publishBatch(jobs, options);
        published += jobs.length;
      },
    },
    async drain() {
      const deadline = Date.now() + 25_000;
      while (acknowledged + deadLetters.length < published) {
        if (Date.now() > deadline) {
          throw new Error(
            `queue did not settle: ${published} published, ${acknowledged} acked, ${deadLetters.length} dead`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}

afterEach(() => installQueueHooks(undefined));

describeJobQueueContract("Cloudflare Queues (miniflare)", (processor) => {
  const tracker = track(processor);
  return {
    queue: tracker.queue,
    drain: () => tracker.drain(),
    deadLetters: () => tracker.deadLetters,
    maxAttempts: MAX_ATTEMPTS,
  };
});

describe("Queues delivery details", () => {
  it("holds a delayed job for its delay", async () => {
    const seen: number[] = [];
    const tracker = track(async () => {
      seen.push(Date.now());
      return { action: "ack" };
    });
    const sentAt = Date.now();
    await tracker.queue.publish({ type: "later.job", payload: 1 }, { delaySec: 1 });
    await tracker.drain();
    expect(seen).toHaveLength(1);
    expect((seen[0] ?? 0) - sentAt).toBeGreaterThanOrEqual(900);
  });

  it("dead-letters messages that are not job envelopes instead of dropping them", async () => {
    const tracker = track(async () => ({ action: "ack" }));
    await env.JOBS.send({ not: "a job" }, { contentType: "json" });
    const deadline = Date.now() + 25_000;
    while (tracker.deadLetters.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(tracker.deadLetters).toHaveLength(1);
  });
});
