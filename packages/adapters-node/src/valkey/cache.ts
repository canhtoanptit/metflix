import {
  assertCacheKey,
  assertCacheTtl,
  assertCacheValue,
  type KeyValueCache,
} from "@webflix/core";
import type { ValkeyConnection } from "./connection.ts";

/**
 * `KeyValueCache` on Valkey: plain strings with a server-side TTL (`SET ... EX`). Expiry is
 * Valkey's own clock, so every replica agrees on it. The port only promises eventual
 * consistency; Valkey gives read-after-write on top, which callers must not rely on (the same
 * code runs on Workers KV).
 */
export function createValkeyCache(valkey: ValkeyConnection): KeyValueCache {
  const { client } = valkey;
  const full = (key: string) => {
    assertCacheKey(key);
    return `${valkey.keyPrefix}cache:${key}`;
  };
  return {
    async get(key) {
      const name = full(key);
      return valkey.guard("cache.get", () => client.get(name));
    },
    async set(key, value, options) {
      const name = full(key);
      assertCacheValue(value);
      assertCacheTtl(options.ttlSec);
      await valkey.guard("cache.set", () => client.set(name, value, "EX", options.ttlSec));
    },
    async delete(key) {
      const name = full(key);
      await valkey.guard("cache.delete", () => client.del(name));
    },
  };
}
