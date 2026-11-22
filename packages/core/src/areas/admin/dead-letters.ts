/**
 * Dead letters in every mode (milestone 2 §8.3, "dead letters with replay"). Each job queue keeps
 * its own dead-letter store (the memory queue's list, Valkey's `dead` stream, the Cloudflare
 * dead-letter queue), none of which the others can read. So the one processor every adapter
 * drives also records, on a job's last attempt, the job into `job_dead_letters`: staff list and
 * replay them the same way on Node and in the Worker.
 */
import type { DeadLetter, DeadLetterPage, JsonValue } from "@webflix/contracts";
import * as z from "zod";
import { decodeCursor, encodeCursor, invalidCursor } from "../../domain/cursor.ts";
import { AppError } from "../../errors.ts";
import { toIsoString } from "../../ports/clock.ts";
import type { JobProcessor } from "../../ports/job-queue.ts";
import { serializeError } from "../../ports/logger.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import type { DeadLetterRecord } from "./repository.ts";

/**
 * Deliveries before a job is dead-lettered, which every adapter uses today: the memory queue's
 * and the Valkey queue's default (5), and Cloudflare Queues' `max_retries` (4) + 1
 * (`JOBS_MAX_ATTEMPTS` in apps/edge, checked against wrangler.jsonc by a test there). A queue
 * configured otherwise must pass its own value to `captureDeadLetters`.
 */
export const JOB_MAX_ATTEMPTS = 5;

const DEFAULT_PAGE = 50;
const DeadLetterCursor = z.object({ f: z.number().int(), i: z.string().min(1).max(128) });

export function presentDeadLetter(record: DeadLetterRecord): DeadLetter {
  return {
    id: record.id,
    jobType: record.jobType,
    attempts: record.attempts,
    lastError: record.lastError,
    failedAt: toIsoString(record.failedAt),
    replayedAt: record.replayedAt === null ? null : toIsoString(record.replayedAt),
  };
}

export interface DeadLetters {
  /**
   * The processor, also recording a job that fails its last attempt. Recording never changes
   * the outcome the adapter sees (it still dead-letters the job in its own store).
   */
  capture(processor: JobProcessor, maxAttempts?: number): JobProcessor;
  list(page: { cursor?: string | undefined; limit?: number | undefined }): Promise<DeadLetterPage>;
  /** Publishes the job again, once per dead letter (`staff_action_conflict` after that). */
  replay(id: string): Promise<DeadLetter>;
  count(): Promise<number>;
}

export function createDeadLetters(deps: ServiceDependencies): DeadLetters {
  const { repos, clock, jobs, logger } = deps;
  const log = logger.child({ component: "admin.dead_letters" });

  return {
    capture(processor, maxAttempts = JOB_MAX_ATTEMPTS) {
      return async (delivery) => {
        const outcome = await processor(delivery);
        if (outcome.action === "retry" && delivery.attempt >= maxAttempts) {
          try {
            await repos.admin.saveDeadLetter({
              id: delivery.id,
              jobType: delivery.type,
              payload: delivery.payload as JsonValue,
              attempts: delivery.attempt,
              // The processor logs each failure with the job id (`job.failed`); it does not
              // hand the error out, so the record points there.
              lastError: null,
              failedAt: clock.now(),
              replayedAt: null,
            });
          } catch (error) {
            log.error("admin.dead_letter_not_recorded", {
              jobId: delivery.id,
              jobType: delivery.type,
              error: serializeError(error),
            });
          }
        }
        return outcome;
      };
    },

    async list({ cursor, limit = DEFAULT_PAGE }) {
      let before: { failedAt: number; id: string } | null = null;
      if (cursor !== undefined) {
        const decoded = decodeCursor(cursor, DeadLetterCursor);
        if (!decoded) throw invalidCursor();
        before = { failedAt: decoded.f, id: decoded.i };
      }
      const rows = await repos.admin.listDeadLetters({ before, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(presentDeadLetter),
        nextCursor:
          rows.length > limit && last ? encodeCursor({ f: last.failedAt, i: last.id }) : null,
      };
    },

    async replay(id) {
      const record = await repos.admin.getDeadLetter(id);
      if (!record) throw new AppError("not_found", { detail: "No such dead letter" });
      const at = clock.now();
      if (!(await repos.admin.claimDeadLetterReplay(id, at))) {
        throw new AppError("staff_action_conflict", {
          detail: "This dead letter was replayed already; a job that failed again is a new one.",
        });
      }
      try {
        await jobs.publish({ type: record.jobType, payload: record.payload });
      } catch (error) {
        await repos.admin.releaseDeadLetterReplay(id, at);
        throw error;
      }
      return presentDeadLetter({ ...record, replayedAt: at });
    },

    count: () => repos.admin.countDeadLetters(),
  };
}
