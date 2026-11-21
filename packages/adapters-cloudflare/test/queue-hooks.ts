import type { JobProcessor } from "@webflix/core";

/** What the job queue contract harness installs for the test Worker's `queue()` handler. */
export interface QueueTestHooks {
  processor: JobProcessor;
  /** `max_retries + 1` of the consumer configured in vitest.config.ts. */
  maxAttempts: number;
  deadLetterQueue: string;
  onDeadLetter(message: Message): void;
}

export function installQueueHooks(hooks: QueueTestHooks | undefined): void {
  (globalThis as { __webflixQueueHooks?: QueueTestHooks }).__webflixQueueHooks = hooks;
}
