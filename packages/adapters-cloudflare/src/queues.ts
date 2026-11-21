import type { JsonValue } from "@webflix/contracts";
import {
  assertJobBatch,
  assertJobMessage,
  assertPublishOptions,
  type JobDelivery,
  type JobOutcome,
  type JobProcessor,
  type JobQueue,
  type Logger,
  noopLogger,
  serializeError,
} from "@webflix/core";

/**
 * Wire format of a job on the queue. Versioned so a consumer can tell an envelope it does not
 * understand (a message from a future deploy) from a broken one; both are retried into the
 * dead-letter queue rather than dropped.
 */
interface JobEnvelope {
  v: 1;
  type: string;
  payload: JsonValue;
}

/**
 * `JobQueue` producer on a Cloudflare Queues binding.
 *
 * Messages are sent as `json` (not the default structured clone) so what is enqueued is
 * exactly the portable JSON form the processor's schemas accept, and so a pull consumer or the
 * dashboard can read dead letters. The port's limits (128 KiB per job, 100 jobs and 256 KiB
 * per batch, 12 h delay) are Queues' own, validated before sending so every mode fails alike.
 */
export function createQueuesJobQueue(queue: Queue): JobQueue {
  return {
    async publish(job, options = {}) {
      assertJobMessage(job);
      assertPublishOptions(options);
      await queue.send(envelope(job), {
        contentType: "json",
        ...(options.delaySec ? { delaySeconds: options.delaySec } : {}),
      });
    },
    async publishBatch(jobs, options = {}) {
      assertJobBatch(jobs);
      assertPublishOptions(options);
      if (jobs.length === 0) return;
      await queue.sendBatch(
        jobs.map((job) => ({
          body: envelope(job),
          contentType: "json" as const,
          ...(options.delaySec ? { delaySeconds: options.delaySec } : {}),
        })),
      );
    },
  };
}

function envelope(job: { type: string; payload: JsonValue }): JobEnvelope {
  return { v: 1, type: job.type, payload: job.payload };
}

function parseEnvelope(body: unknown): JobEnvelope | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Partial<JobEnvelope>;
  if (candidate.v !== 1 || typeof candidate.type !== "string" || !("payload" in candidate)) {
    return null;
  }
  return candidate as JobEnvelope;
}

export interface QueueConsumerOptions {
  logger?: Logger;
  /**
   * The consumer's `max_retries + 1` from wrangler config. Only used to log the final failed
   * attempt loudly (Queues then moves the message to the dead-letter queue by itself).
   */
  maxAttempts?: number;
}

/**
 * The `queue()` handler body: feeds each message to the `JobProcessor` and maps its outcome to
 * Queues semantics.
 *
 * - Messages are settled one by one (`ack()` / `retry()`), never as a batch, so one failing job
 *   does not redeliver the others.
 * - `retry` carries the processor's backoff as `delaySeconds`; a processor that throws (it
 *   should not: `createJobProcessor` catches) falls back to the consumer's `retry_delay`.
 * - After `max_retries` Queues moves the message to the configured dead-letter queue; nothing
 *   is dropped silently. Delivery is at-least-once, so handlers are idempotent (they are:
 *   rollups recompute, cleanups are conditional deletes).
 * - Processed sequentially: jobs are small D1-bound units, and sequential work keeps a batch
 *   well inside the per-invocation connection and query limits.
 */
export function createQueueConsumer(
  processor: JobProcessor,
  options: QueueConsumerOptions = {},
): (batch: MessageBatch) => Promise<void> {
  const logger = options.logger ?? noopLogger;
  return async (batch) => {
    for (const message of batch.messages) {
      const job = parseEnvelope(message.body);
      const context = { queue: batch.queue, messageId: message.id, attempt: message.attempts };
      if (!job) {
        logger.error("job.malformed_message", context);
        message.retry();
        continue;
      }
      const delivery: JobDelivery = {
        id: message.id,
        type: job.type,
        payload: job.payload,
        attempt: message.attempts,
        enqueuedAt: message.timestamp.getTime(),
      };
      let outcome: JobOutcome;
      try {
        outcome = await processor(delivery);
      } catch (error) {
        logger.warn("job.processor_threw", { ...context, error: serializeError(error) });
        outcome = { action: "retry" };
      }
      if (outcome.action === "ack") {
        message.ack();
        continue;
      }
      if (options.maxAttempts !== undefined && message.attempts >= options.maxAttempts) {
        logger.error("job.dead_lettered", { ...context, jobType: job.type });
      }
      message.retry(outcome.delaySec === undefined ? {} : { delaySeconds: outcome.delaySec });
    }
  };
}
