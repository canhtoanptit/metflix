import {
  assertCacheKey,
  assertCacheTtl,
  assertCacheValue,
  type KeyValueCache,
} from "@webflix/core";

/**
 * `KeyValueCache` on Workers KV. KV is eventually consistent (writes can take ~60 s to be
 * visible elsewhere) and its minimum TTL is 60 s; the port's contract is shaped around both.
 */
export function createKvCache(namespace: KVNamespace): KeyValueCache {
  return {
    async get(key) {
      assertCacheKey(key);
      return namespace.get(key, "text");
    },
    async set(key, value, options) {
      assertCacheKey(key);
      assertCacheValue(value);
      assertCacheTtl(options.ttlSec);
      await namespace.put(key, value, { expirationTtl: options.ttlSec });
    },
    async delete(key) {
      assertCacheKey(key);
      await namespace.delete(key);
    },
  };
}
