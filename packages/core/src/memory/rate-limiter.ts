import { type Clock, systemClock } from "../ports/clock.ts";
import {
  assertRateLimitPolicy,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimitPolicy,
} from "../ports/rate-limiter.ts";

const TOLERANCE_MS = 0.5;

/**
 * In-process `RateLimiter` using GCRA (the generic cell rate algorithm): one timestamp per
 * key, allows bursts of `limit` and refills smoothly at `limit / windowSec`. The same
 * algorithm is a few lines of Lua on Valkey or a field in a Durable Object.
 */
export class MemoryRateLimiter implements RateLimiter {
  /** Theoretical arrival time per `policy\0key`, epoch ms. */
  private readonly tat = new Map<string, number>();
  private readonly clock: Clock;
  private readonly maxKeys: number;

  constructor(options: { clock?: Clock; maxKeys?: number } = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxKeys = options.maxKeys ?? 100_000;
  }

  async consume(policy: RateLimitPolicy, key: string): Promise<RateLimitDecision> {
    assertRateLimitPolicy(policy);
    const now = this.clock.now();
    const windowMs = policy.windowSec * 1000;
    const interval = windowMs / policy.limit;
    const id = `${policy.name}\u0000${key}`;

    const tat = Math.max(this.tat.get(id) ?? now, now);
    const nextTat = tat + interval;
    const allowAt = nextTat - windowMs;
    // Clock time has millisecond resolution; `interval` is fractional when the window does not
    // divide evenly (9 per 60 s), and float error must not deny the last request of a burst.
    if (allowAt - now >= TOLERANCE_MS) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((allowAt - now) / 1000)) };
    }
    this.tat.delete(id);
    this.tat.set(id, nextTat);
    this.sweep(now);
    const remaining = Math.floor((now + windowMs - nextTat + TOLERANCE_MS) / interval);
    return { allowed: true, remaining };
  }

  private sweep(now: number): void {
    if (this.tat.size <= this.maxKeys) return;
    for (const [id, tat] of this.tat) {
      if (tat <= now) this.tat.delete(id);
    }
    for (const id of this.tat.keys()) {
      if (this.tat.size <= this.maxKeys) break;
      this.tat.delete(id);
    }
  }
}
