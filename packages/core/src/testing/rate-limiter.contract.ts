import { describe, expect, it } from "vitest";
import type { RateLimiter, RateLimitPolicy } from "../ports/rate-limiter.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

export interface RateLimiterHarness extends HarnessBase {
  limiter: RateLimiter;
}

/**
 * Contract every `RateLimiter` adapter must pass. Policies use a 60 s window, which the
 * Workers rate-limit binding supports.
 */
export function describeRateLimiterContract(
  name: string,
  factory: HarnessFactory<RateLimiterHarness>,
): void {
  describe(`RateLimiter contract: ${name}`, () => {
    const h = useHarness(factory);
    const unique = () => `k-${crypto.randomUUID()}`;
    const policy: RateLimitPolicy = { name: "contract", limit: 3, windowSec: 60 };

    it("allows `limit` requests, then denies with a Retry-After within the window", async () => {
      const { limiter } = h();
      const key = unique();
      for (let index = 0; index < policy.limit; index += 1) {
        expect((await limiter.consume(policy, key)).allowed).toBe(true);
      }
      const denied = await limiter.consume(policy, key);
      expect(denied.allowed).toBe(false);
      if (denied.allowed) return;
      expect(Number.isInteger(denied.retryAfterSec)).toBe(true);
      expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
      expect(denied.retryAfterSec).toBeLessThanOrEqual(policy.windowSec);
    });

    it("honours limits that do not divide the window evenly", async () => {
      const { limiter } = h();
      for (const uneven of [
        { name: "contract-9-60", limit: 9, windowSec: 60 },
        { name: "contract-7-10", limit: 7, windowSec: 10 },
      ]) {
        const key = unique();
        const allowed: boolean[] = [];
        for (let index = 0; index <= uneven.limit; index += 1) {
          allowed.push((await limiter.consume(uneven, key)).allowed);
        }
        expect(allowed.filter(Boolean), uneven.name).toHaveLength(uneven.limit);
        expect(allowed.at(-1), uneven.name).toBe(false);
      }
    });

    it("reports remaining as null or counting down to zero", async () => {
      const { limiter } = h();
      const key = unique();
      const remaining: (number | null)[] = [];
      for (let index = 0; index < policy.limit; index += 1) {
        const decision = await limiter.consume(policy, key);
        if (decision.allowed) remaining.push(decision.remaining);
      }
      if (remaining.every((value) => value === null)) return;
      expect(remaining).toEqual([2, 1, 0]);
    });

    it("keeps keys independent", async () => {
      const { limiter } = h();
      const [a, b] = [unique(), unique()];
      for (let index = 0; index < policy.limit; index += 1) await limiter.consume(policy, a);
      expect((await limiter.consume(policy, a)).allowed).toBe(false);
      expect((await limiter.consume(policy, b)).allowed).toBe(true);
    });

    it("keeps policies independent for the same key", async () => {
      const { limiter } = h();
      const key = unique();
      const other: RateLimitPolicy = { ...policy, name: "contract-other" };
      for (let index = 0; index < policy.limit; index += 1) await limiter.consume(policy, key);
      expect((await limiter.consume(policy, key)).allowed).toBe(false);
      expect((await limiter.consume(other, key)).allowed).toBe(true);
    });

    it("never allows more than `limit` under concurrent requests", async () => {
      const { limiter } = h();
      const key = unique();
      const decisions = await Promise.all(
        Array.from({ length: policy.limit * 3 }, () => limiter.consume(policy, key)),
      );
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(policy.limit);
    });

    it("restores the full limit after two windows", async (context) => {
      const { limiter, time } = h();
      if (!time) return context.skip();
      const key = unique();
      for (let index = 0; index < policy.limit; index += 1) await limiter.consume(policy, key);
      expect((await limiter.consume(policy, key)).allowed).toBe(false);
      await time.advance(policy.windowSec * 2 * 1000);
      for (let index = 0; index < policy.limit; index += 1) {
        expect((await limiter.consume(policy, key)).allowed).toBe(true);
      }
    });

    it("rejects invalid policies", async () => {
      const { limiter } = h();
      await expect(limiter.consume({ ...policy, limit: 0 }, unique())).rejects.toThrow();
      await expect(limiter.consume({ ...policy, windowSec: 0 }, unique())).rejects.toThrow();
    });
  });
}
