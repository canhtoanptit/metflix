import { type Clock, systemClock } from "../ports/clock.ts";
import { createUuidV7Generator, type IdGenerator } from "../ports/ids.ts";
import {
  assertJobBatch,
  assertJobMessage,
  assertPublishOptions,
  type JobDelivery,
  type JobMessage,
  type JobOutcome,
  type JobProcessor,
  type JobQueue,
  type PublishOptions,
} from "../ports/job-queue.ts";
import { type Logger, noopLogger, serializeError } from "../ports/logger.ts";

interface QueuedJob {
  id: string;
  message: JobMessage;
  attempts: number;
  enqueuedAt: number;
  availableAt: number;
}

export interface MemoryJobQueueOptions {
  processor?: JobProcessor;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
  /** Deliveries before a job is dead-lettered. Default 5 (Cloudflare Queues' default is 3). */
  maxAttempts?: number;
  /** Delay for retries the processor requests without `delaySec`, and for thrown errors. */
  defaultRetryDelaySec?: number;
}

/**
 * In-process `JobQueue` for dev mode and tests. `drain()` delivers every job that is due
 * (deterministic with a `ManualClock`); `start()` polls in the background for dev mode.
 * Payloads round-trip through JSON so handlers never share objects with producers.
 */
export class MemoryJobQueue implements JobQueue {
  readonly deadLetters: JobDelivery[] = [];
  private readonly queue: QueuedJob[] = [];
  private processor: JobProcessor | undefined;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;
  private readonly maxAttempts: number;
  private readonly defaultRetryDelaySec: number;
  private draining: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: MemoryJobQueueOptions = {}) {
    this.processor = options.processor;
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? createUuidV7Generator({ clock: this.clock });
    this.logger = options.logger ?? noopLogger;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.defaultRetryDelaySec = options.defaultRetryDelaySec ?? 0;
  }

  setProcessor(processor: JobProcessor): void {
    this.processor = processor;
  }

  /** Jobs not yet acknowledged or dead-lettered (including delayed ones). */
  get size(): number {
    return this.queue.length;
  }

  async publish(job: JobMessage, options: PublishOptions = {}): Promise<void> {
    assertJobMessage(job);
    assertPublishOptions(options);
    this.enqueue(job, options);
  }

  async publishBatch(jobs: readonly JobMessage[], options: PublishOptions = {}): Promise<void> {
    assertJobBatch(jobs);
    assertPublishOptions(options);
    for (const job of jobs) this.enqueue(job, options);
  }

  /** Deliver due jobs until none are due. Concurrent calls share one run. */
  drain(): Promise<void> {
    this.draining ??= this.run().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  /** Poll for due jobs in the background (dev mode). */
  start(pollIntervalMs = 250): void {
    if (this.timer !== undefined) return;
    const tick = () => {
      this.drain()
        .catch((error: unknown) =>
          this.logger.error("job_queue.drain_failed", { error: serializeError(error) }),
        )
        .finally(() => {
          if (this.timer !== undefined) this.timer = setTimeout(tick, pollIntervalMs);
        });
    };
    this.timer = setTimeout(tick, pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  private enqueue(job: JobMessage, options: PublishOptions): void {
    const now = this.clock.now();
    this.queue.push({
      id: this.ids.next(),
      message: { type: job.type, payload: JSON.parse(JSON.stringify(job.payload)) },
      attempts: 0,
      enqueuedAt: now,
      availableAt: now + (options.delaySec ?? 0) * 1000,
    });
  }

  private async run(): Promise<void> {
    const processor = this.processor;
    if (!processor) return;
    for (;;) {
      const now = this.clock.now();
      const index = this.queue.findIndex((job) => job.availableAt <= now);
      const job = this.queue[index];
      if (!job) return;
      job.attempts += 1;
      const delivery: JobDelivery = {
        id: job.id,
        type: job.message.type,
        payload: JSON.parse(JSON.stringify(job.message.payload)),
        attempt: job.attempts,
        enqueuedAt: job.enqueuedAt,
      };

      let outcome: JobOutcome;
      try {
        outcome = await processor(delivery);
      } catch (error) {
        this.logger.warn("job_queue.processor_threw", {
          jobId: job.id,
          error: serializeError(error),
        });
        outcome = { action: "retry" };
      }

      if (outcome.action === "ack") {
        this.queue.splice(this.queue.indexOf(job), 1);
      } else if (job.attempts >= this.maxAttempts) {
        this.queue.splice(this.queue.indexOf(job), 1);
        this.deadLetters.push(delivery);
        this.logger.error("job_queue.dead_lettered", { jobId: job.id, jobType: delivery.type });
      } else {
        job.availableAt = this.clock.now() + (outcome.delaySec ?? this.defaultRetryDelaySec) * 1000;
      }
    }
  }
}
