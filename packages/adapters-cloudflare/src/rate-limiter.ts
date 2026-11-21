import { DurableObject } from "cloudflare:workers";
import {
  assertRateLimitPolicy,
  type Clock,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimitPolicy,
  systemClock,
} from "@webflix/core";

/** Float tolerance for windows that do not divide evenly (9 per 60 s); same as the memory adapter. */
const TOLERANCE_MS = 0.5;

interface LimiterState {
  /** GCRA theoretical arrival time, in the caller's clock (epoch ms). */
  tat: number;
  /** When the state stops mattering, in this object's clock: the alarm deletes it then. */
  idleAt: number;
}

/**
 * One rate-limit counter (`policy:key`) as a Durable Object.
 *
 * Why a Durable Object: the port requires exact, atomic counting across every isolate and
 * location. A Durable Object is a single-threaded actor with strongly consistent storage, so
 * the read-modify-write below is atomic by construction: `consume` is synchronous (the SQLite
 * KV API never yields), so no other request to this object can interleave with it, and the
 * output gate holds the response until the write is durable. Neither Workers KV (eventually
 * consistent) nor the rate-limiting binding (approximate, per location) can do this.
 *
 * Algorithm: GCRA, one timestamp per key, identical to `MemoryRateLimiter`. Time comes from the
 * caller (`now`) so the contract suite can drive it with a `ManualClock`; in production the
 * caller passes `Date.now()`.
 *
 * Storage hygiene: one object per client address would otherwise keep a row forever. Once the
 * TAT is in the past the full burst is available again and the state is meaningless, so an
 * alarm at that moment deletes it: idle limiters cost nothing.
 */
export class RateLimiterObject extends DurableObject {
  consume(policy: RateLimitPolicy, now: number): RateLimitDecision {
    assertRateLimitPolicy(policy);
    const kv = this.ctx.storage.kv;
    const windowMs = policy.windowSec * 1000;
    const interval = windowMs / policy.limit;
    const state = kv.get<LimiterState>("state");

    const tat = Math.max(state?.tat ?? now, now);
    const nextTat = tat + interval;
    const allowAt = nextTat - windowMs;
    if (allowAt - now >= TOLERANCE_MS) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((allowAt - now) / 1000)) };
    }
    // The alarm runs on this object's clock; convert the remaining span rather than the instant.
    const idleAt = Date.now() + Math.ceil(nextTat - now);
    kv.put("state", { tat: nextTat, idleAt } satisfies LimiterState);
    // One pending alarm is enough: when it fires early it re-arms itself for the latest
    // `idleAt`. Skipping the write keeps an allowed request at a single storage write. Not
    // awaited: the output gate already holds the response until storage has committed.
    if (!state) void this.ctx.storage.setAlarm(idleAt);
    const remaining = Math.floor((now + windowMs - nextTat + TOLERANCE_MS) / interval);
    return { allowed: true, remaining };
  }

  override async alarm(): Promise<void> {
    const state = this.ctx.storage.kv.get<LimiterState>("state");
    if (state && state.idleAt > Date.now()) {
      await this.ctx.storage.setAlarm(state.idleAt);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}

export interface DurableObjectRateLimiterOptions {
  /** Time source passed to the objects. Default: the system clock. */
  clock?: Clock;
}

/**
 * `RateLimiter` backed by `RateLimiterObject`, one object per `policy:key` (an IP address
 * before sign-in, an account after). Each decision is one Durable Object call.
 */
export function createDurableObjectRateLimiter(
  namespace: DurableObjectNamespace<RateLimiterObject>,
  options: DurableObjectRateLimiterOptions = {},
): RateLimiter {
  const clock = options.clock ?? systemClock;
  return {
    async consume(policy, key) {
      assertRateLimitPolicy(policy);
      const stub = namespace.getByName(`${policy.name}:${key}`);
      // Plain data across the RPC boundary (policies may be frozen config objects).
      const plain = { name: policy.name, limit: policy.limit, windowSec: policy.windowSec };
      return stub.consume(plain, clock.now());
    },
  };
}
