import type { JsonValue } from "@webflix/contracts";
import type { z } from "zod";
import { utf8ByteLength } from "../encoding.ts";
import { type Logger, noopLogger, serializeError } from "./logger.ts";

/** Cloudflare Queues limits, enforced by every adapter so behaviour matches across modes. */
export const MAX_JOB_PAYLOAD_BYTES = 128 * 1024;
export const MAX_JOB_DELAY_SEC = 12 * 60 * 60;
export const MAX_JOB_BATCH_SIZE = 100;
export const MAX_JOB_BATCH_BYTES = 256 * 1024;

export interface JobMessage {
  /** Dotted job name, e.g. `stats.rollup`. */
  type: string;
  /** JSON payload, at most 128 KiB once serialised. */
  payload: JsonValue;
}

export interface PublishOptions {
  /** Delay before the first delivery, 0..43200 seconds. */
  delaySec?: number;
}

/**
 * Port: background jobs, producer side (in-process / Valkey Streams / Cloudflare Queues).
 *
 * Delivery is at-least-once; jobs may be delivered more than once and in any order, so
 * handlers must be idempotent. There is no deduplication (Queues has none).
 */
export interface JobQueue {
  publish(job: JobMessage, options?: PublishOptions): Promise<void>;
  /** Up to 100 jobs; all-or-nothing validation, best-effort delivery. */
  publishBatch(jobs: readonly JobMessage[], options?: PublishOptions): Promise<void>;
}

/** One delivery of a job to the consumer. */
export interface JobDelivery extends JobMessage {
  /** Stable across redeliveries of the same job. */
  id: string;
  /** 1 on the first delivery. */
  attempt: number;
  /** Epoch milliseconds. */
  enqueuedAt: number;
}

export type JobOutcome = { action: "ack" } | { action: "retry"; delaySec?: number };

/**
 * Consumer side. Adapters feed every delivery to one processor and honour its outcome:
 * `ack` removes the job; `retry` (or a thrown error) redelivers it after `delaySec` until the
 * adapter's max attempts, then dead-letters it. Wire-up per runtime:
 * memory: `MemoryJobQueue`; Workers: the `queue()` handler calls the processor per message
 * and maps the outcome to `message.ack()` / `message.retry({ delaySeconds })`; Node worker:
 * a consumer-group loop over Valkey Streams.
 */
export type JobProcessor = (delivery: JobDelivery) => Promise<JobOutcome>;

const JOB_TYPE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

/** Serialised size of a job as it travels (the `{type, payload}` envelope counts). */
function jobBytes(job: JobMessage): number {
  return utf8ByteLength(JSON.stringify({ type: job.type, payload: job.payload }));
}

export function assertJobMessage(job: JobMessage): void {
  if (!JOB_TYPE_PATTERN.test(job.type)) throw new TypeError(`Invalid job type "${job.type}"`);
  if (jobBytes(job) > MAX_JOB_PAYLOAD_BYTES) {
    throw new RangeError(`Job exceeds ${MAX_JOB_PAYLOAD_BYTES} bytes once serialised`);
  }
}

export function assertPublishOptions(options: PublishOptions = {}): void {
  const delay = options.delaySec ?? 0;
  if (!Number.isInteger(delay) || delay < 0 || delay > MAX_JOB_DELAY_SEC) {
    throw new RangeError(`delaySec must be an integer in 0..${MAX_JOB_DELAY_SEC}`);
  }
}

export function assertJobBatch(jobs: readonly JobMessage[]): void {
  if (jobs.length > MAX_JOB_BATCH_SIZE) {
    throw new RangeError(`At most ${MAX_JOB_BATCH_SIZE} jobs per batch`);
  }
  for (const job of jobs) assertJobMessage(job);
  const total = jobs.reduce((sum, job) => sum + jobBytes(job), 0);
  if (total > MAX_JOB_BATCH_BYTES) {
    throw new RangeError(`A batch exceeds ${MAX_JOB_BATCH_BYTES} bytes in total`);
  }
}

// --- Typed jobs -------------------------------------------------------------------------------

export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  readonly type: string;
  readonly schema: S;
  /**
   * Validate and wrap a payload for `publish`. The *input* form is sent (the consumer parses it
   * again), so payload schemas must accept their JSON form: no `z.date()`, use ISO strings.
   */
  create(payload: z.input<S>): JobMessage;
}

/** Declare a job type with a payload schema; share the definition between producer and consumer. */
export function defineJob<S extends z.ZodType>(type: string, schema: S): JobDefinition<S> {
  if (!JOB_TYPE_PATTERN.test(type)) throw new TypeError(`Invalid job type "${type}"`);
  return {
    type,
    schema,
    create(payload) {
      // Validated at publish time so bad payloads fail in the producer, not in the worker.
      schema.parse(payload);
      return { type, payload: payload as JsonValue };
    },
  };
}

export interface JobContext {
  id: string;
  attempt: number;
  enqueuedAt: number;
  logger: Logger;
}

export interface JobBinding {
  readonly definition: JobDefinition;
  readonly handle: (payload: unknown, context: JobContext) => Promise<void>;
}

/** Pair a definition with its handler (keeps the payload type correlated). */
export function handleJob<S extends z.ZodType>(
  definition: JobDefinition<S>,
  handler: (payload: z.output<S>, context: JobContext) => Promise<void>,
): JobBinding {
  return { definition, handle: (payload, context) => handler(payload as z.output<S>, context) };
}

export interface JobProcessorOptions {
  jobs: readonly JobBinding[];
  logger?: Logger;
  /** Exponential backoff for failed handlers: base * 2^(attempt-1), capped. */
  retry?: { baseDelaySec?: number; maxDelaySec?: number };
}

/**
 * Build the processor every adapter drives. Handler errors, unknown job types and payloads
 * that fail their schema are all retried with exponential backoff, so they end up in the
 * adapter's dead-letter queue instead of vanishing. (During a rolling deploy an old worker may
 * receive a job only the new code understands; retrying lets a new worker pick it up.)
 */
export function createJobProcessor(options: JobProcessorOptions): JobProcessor {
  const logger = options.logger ?? noopLogger;
  const base = options.retry?.baseDelaySec ?? 5;
  const max = Math.min(options.retry?.maxDelaySec ?? 3600, MAX_JOB_DELAY_SEC);
  const bindings = new Map<string, JobBinding>();
  for (const binding of options.jobs) {
    if (bindings.has(binding.definition.type)) {
      throw new Error(`Duplicate handler for job type ${binding.definition.type}`);
    }
    bindings.set(binding.definition.type, binding);
  }

  return async (delivery) => {
    const jobLogger = logger.child({
      jobId: delivery.id,
      jobType: delivery.type,
      attempt: delivery.attempt,
    });
    const delaySec = Math.min(base * 2 ** (delivery.attempt - 1), max);
    const binding = bindings.get(delivery.type);
    if (!binding) {
      jobLogger.error("job.unknown_type", { retryInSec: delaySec });
      return { action: "retry", delaySec };
    }
    const parsed = binding.definition.schema.safeParse(delivery.payload);
    if (!parsed.success) {
      jobLogger.error("job.invalid_payload", { issues: parsed.error.issues, retryInSec: delaySec });
      return { action: "retry", delaySec };
    }
    try {
      await binding.handle(parsed.data, {
        id: delivery.id,
        attempt: delivery.attempt,
        enqueuedAt: delivery.enqueuedAt,
        logger: jobLogger,
      });
      return { action: "ack" };
    } catch (error) {
      jobLogger.warn("job.failed", { error: serializeError(error), retryInSec: delaySec });
      return { action: "retry", delaySec };
    }
  };
}
