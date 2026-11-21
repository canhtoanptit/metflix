/** A named limit: at most `limit` requests per `windowSec` per key. */
export interface RateLimitPolicy {
  readonly name: string;
  readonly limit: number;
  readonly windowSec: number;
}

export type RateLimitDecision =
  | {
      allowed: true;
      /** Requests left in the current window; null when the backend cannot tell. */
      remaining: number | null;
    }
  | {
      allowed: false;
      /** Seconds until a request may succeed (send as `Retry-After`). 1..windowSec. */
      retryAfterSec: number;
    };

/**
 * Port: rate limiting (memory / Valkey / Durable Object).
 *
 * Contract: for a fresh key, the first `limit` calls within one window are allowed and the
 * next is denied; keys and policies are independent; after `2 * windowSec` without traffic the
 * full limit is available again. The algorithm (fixed window, sliding window, GCRA) is the
 * adapter's choice. Counting must be exact and atomic across instances.
 *
 * On Cloudflare use a Durable Object keyed by `policy:key`. Neither Workers KV (eventually
 * consistent) nor the Workers rate-limiting binding (approximate, per location, limits fixed
 * in wrangler config, no retry time) can honour this contract.
 */
export interface RateLimiter {
  consume(policy: RateLimitPolicy, key: string): Promise<RateLimitDecision>;
}

export function assertRateLimitPolicy(policy: RateLimitPolicy): void {
  if (!/^[a-z0-9-]{1,32}$/.test(policy.name)) throw new TypeError("Invalid rate limit policy name");
  if (!Number.isInteger(policy.limit) || policy.limit < 1) {
    throw new RangeError("Rate limit must be a positive integer");
  }
  if (!Number.isInteger(policy.windowSec) || policy.windowSec < 1) {
    throw new RangeError("Rate limit windowSec must be a positive integer");
  }
}
