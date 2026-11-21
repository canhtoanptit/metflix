import {
  assertRateLimitPolicy,
  type Clock,
  type RateLimitDecision,
  type RateLimiter,
} from "@webflix/core";
import { LUA_NOW, LuaScript, type ValkeyConnection } from "./connection.ts";

/**
 * GCRA, the same algorithm and arithmetic as `MemoryRateLimiter` (bursts of `limit`, smooth
 * refill at `limit / windowSec`), run as one Lua script so the read-modify-write of the
 * theoretical arrival time is atomic across every replica. One key per `policy:key`, expiring
 * when it no longer constrains anything.
 */
const CONSUME = new LuaScript(`${LUA_NOW}
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = now_ms(ARGV[3])
local interval = window / limit
local stored = tonumber(redis.call('GET', KEYS[1]))
local tat = now
if stored and stored > now then tat = stored end
local next_tat = tat + interval
local allow_at = next_tat - window
-- Millisecond clocks and fractional intervals (9 per 60 s): tolerate float error.
if allow_at - now >= 0.5 then
  return {0, math.max(1, math.ceil((allow_at - now) / 1000))}
end
redis.call('SET', KEYS[1], string.format('%.3f', next_tat), 'PX', math.max(1, math.ceil(next_tat - now)))
return {1, math.floor((now + window - next_tat + 0.5) / interval)}
`);

export interface ValkeyRateLimiterOptions {
  /** Tests only: read time from this clock instead of Valkey's `TIME`. */
  clock?: Clock;
}

export function createValkeyRateLimiter(
  valkey: ValkeyConnection,
  options: ValkeyRateLimiterOptions = {},
): RateLimiter {
  return {
    async consume(policy, key): Promise<RateLimitDecision> {
      assertRateLimitPolicy(policy);
      const name = `${valkey.keyPrefix}rl:${policy.name}:${key}`;
      const now = options.clock ? String(options.clock.now()) : "";
      const [allowed, value] = (await valkey.guard("rate_limiter.consume", () =>
        CONSUME.run(valkey.client, [name], [policy.limit, policy.windowSec * 1000, now]),
      )) as [number, number];
      return allowed === 1
        ? { allowed: true, remaining: value }
        : { allowed: false, retryAfterSec: value };
    },
  };
}
