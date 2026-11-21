import { describe, expect, it } from "vitest";
import {
  type JobDelivery,
  type JobOutcome,
  type JobProcessor,
  type JobQueue,
  MAX_JOB_BATCH_SIZE,
  MAX_JOB_DELAY_SEC,
  MAX_JOB_PAYLOAD_BYTES,
} from "../ports/job-queue.ts";
import type { HarnessBase } from "./harness.ts";
import { useHarness } from "./harness.ts";

export interface JobQueueHarness extends HarnessBase {
  queue: JobQueue;
  /** Resolves once every job that is currently due has been delivered and settled. */
  drain(): Promise<void>;
  /** Deliveries that exhausted their attempts. Omit if the backend cannot expose them. */
  deadLetters?(): JobDelivery[] | Promise<JobDelivery[]>;
  /** The adapter's configured max attempts (required with `deadLetters`). */
  maxAttempts?: number;
}

/**
 * The harness wires `processor` into the adapter's delivery mechanism (memory: constructor
 * option; Workers: the queue() handler; Valkey: the consumer loop).
 */
export type JobQueueHarnessFactory = (
  processor: JobProcessor,
) => JobQueueHarness | Promise<JobQueueHarness>;

/** Contract every `JobQueue` adapter (producer + delivery) must pass. */
export function describeJobQueueContract(name: string, factory: JobQueueHarnessFactory): void {
  describe(`JobQueue contract: ${name}`, () => {
    let deliveries: JobDelivery[] = [];
    let decide: (delivery: JobDelivery) => JobOutcome | Promise<JobOutcome> = () => ({
      action: "ack",
    });
    const processor: JobProcessor = async (delivery) => {
      deliveries.push(delivery);
      return decide(delivery);
    };
    const h = useHarness(async () => {
      deliveries = [];
      decide = () => ({ action: "ack" });
      return factory(processor);
    });

    it("delivers a published job with id, type, payload and attempt 1", async () => {
      const { queue, drain } = h();
      await queue.publish({ type: "stats.rollup", payload: { day: "2026-01-01", n: [1, 2] } });
      await drain();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        type: "stats.rollup",
        payload: { day: "2026-01-01", n: [1, 2] },
        attempt: 1,
      });
      expect(deliveries[0]?.id).toEqual(expect.any(String));
      expect(deliveries[0]?.enqueuedAt).toEqual(expect.any(Number));
    });

    it("delivers every job of a batch", async () => {
      const { queue, drain } = h();
      await queue.publishBatch([
        { type: "a.one", payload: 1 },
        { type: "a.two", payload: 2 },
        { type: "a.three", payload: 3 },
      ]);
      await drain();
      expect(deliveries.map((delivery) => delivery.payload).sort()).toEqual([1, 2, 3]);
    });

    it("redelivers a job the processor asks to retry, with the same id", async () => {
      const { queue, drain } = h();
      decide = (delivery) =>
        delivery.attempt < 3 ? { action: "retry", delaySec: 0 } : { action: "ack" };
      await queue.publish({ type: "flaky.job", payload: null });
      await drain();
      expect(deliveries.map((delivery) => delivery.attempt)).toEqual([1, 2, 3]);
      expect(new Set(deliveries.map((delivery) => delivery.id)).size).toBe(1);
    });

    it("redelivers when the processor throws", async () => {
      const { queue, drain } = h();
      decide = (delivery) => {
        if (delivery.attempt === 1) throw new Error("boom");
        return { action: "ack" };
      };
      await queue.publish({ type: "throws.once", payload: "x" });
      await drain();
      expect(deliveries.map((delivery) => delivery.attempt)).toEqual([1, 2]);
    });

    it("dead-letters a job after the maximum attempts", async (context) => {
      const { queue, drain, deadLetters, maxAttempts } = h();
      if (!deadLetters || !maxAttempts) return context.skip();
      decide = () => ({ action: "retry", delaySec: 0 });
      await queue.publish({ type: "always.fails", payload: { id: 7 } });
      await drain();
      expect(deliveries).toHaveLength(maxAttempts);
      const dead = await deadLetters();
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({ type: "always.fails", payload: { id: 7 } });
    });

    it("holds delayed jobs until their delay has passed", async (context) => {
      const { queue, drain, time } = h();
      if (!time) return context.skip();
      await queue.publish({ type: "later.job", payload: 1 }, { delaySec: 30 });
      await drain();
      expect(deliveries).toHaveLength(0);
      await time.advance(30_000);
      await drain();
      expect(deliveries).toHaveLength(1);
    });

    it("snapshots the payload at publish time", async () => {
      const { queue, drain } = h();
      const payload = { items: ["a"] };
      await queue.publish({ type: "snap.shot", payload });
      payload.items.push("b");
      await drain();
      expect(deliveries[0]?.payload).toEqual({ items: ["a"] });
    });

    it("enforces the portable limits (job size, type, batch count and bytes, delay)", async () => {
      const { queue } = h();
      const big = "x".repeat(MAX_JOB_PAYLOAD_BYTES + 1);
      await expect(queue.publish({ type: "too.big", payload: big })).rejects.toThrow(RangeError);
      await expect(queue.publish({ type: "Bad Type", payload: 1 })).rejects.toThrow(TypeError);
      const batch = Array.from({ length: MAX_JOB_BATCH_SIZE + 1 }, () => ({
        type: "a.b",
        payload: 1,
      }));
      await expect(queue.publishBatch(batch)).rejects.toThrow(RangeError);
      // Each job fits, but together they exceed the total batch size.
      const heavy = Array.from({ length: 3 }, () => ({
        type: "a.b",
        payload: "x".repeat(100_000),
      }));
      await expect(queue.publishBatch(heavy)).rejects.toThrow(RangeError);
      await expect(
        queue.publish({ type: "a.b", payload: 1 }, { delaySec: MAX_JOB_DELAY_SEC + 1 }),
      ).rejects.toThrow(RangeError);
    });
  });
}
