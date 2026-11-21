import type { z } from "zod";
import { utf8ByteLength } from "../encoding.ts";

/** Workers KV rejects shorter TTLs; every adapter enforces the same floor. */
export const MIN_CACHE_TTL_SEC = 60;
export const MAX_CACHE_KEY_BYTES = 512;
export const MAX_CACHE_VALUE_BYTES = 1024 * 1024;

/**
 * Port: best-effort TTL cache (memory / Valkey / Workers KV).
 *
 * Semantics every adapter must honour, chosen so Workers KV can implement them:
 * - Eventually consistent: after `set` or `delete`, other readers (other isolates, regions)
 *   may see the old value for up to ~60 s. Never store read-after-write state here (sessions,
 *   revocations, stream counts, rate limits); use the database or a Durable Object.
 * - `ttlSec` >= 60. Values are strings (JSON-encode with `createJsonCache`).
 * - A missing or expired key reads as `null`; `delete` of a missing key is not an error.
 */
export interface KeyValueCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { ttlSec: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function assertCacheKey(key: string): void {
  if (key.length === 0) throw new TypeError("Cache key must not be empty");
  if (utf8ByteLength(key) > MAX_CACHE_KEY_BYTES) {
    throw new RangeError(`Cache key exceeds ${MAX_CACHE_KEY_BYTES} bytes`);
  }
}

export function assertCacheTtl(ttlSec: number): void {
  if (!Number.isInteger(ttlSec) || ttlSec < MIN_CACHE_TTL_SEC) {
    throw new RangeError(`Cache ttlSec must be an integer >= ${MIN_CACHE_TTL_SEC}`);
  }
}

export function assertCacheValue(value: string): void {
  if (utf8ByteLength(value) > MAX_CACHE_VALUE_BYTES) {
    throw new RangeError(`Cache value exceeds ${MAX_CACHE_VALUE_BYTES} bytes`);
  }
}

/** Namespace a cache: every key is prefixed with `prefix`. */
export function prefixedCache(cache: KeyValueCache, prefix: string): KeyValueCache {
  // Validate the logical key too: a prefix must not make an empty key acceptable.
  const full = (key: string) => {
    assertCacheKey(key);
    return `${prefix}${key}`;
  };
  return {
    get: async (key) => cache.get(full(key)),
    set: async (key, value, options) => cache.set(full(key), value, options),
    delete: async (key) => cache.delete(full(key)),
  };
}

export interface JsonCache<T> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Cache-aside: return the cached value or load, store and return it. */
  getOrLoad(key: string, load: () => Promise<T>): Promise<T>;
}

/**
 * Typed JSON view over a cache. Cached values are validated on read; anything that no longer
 * matches the schema (deploy changed the shape) is treated as a miss.
 */
export function createJsonCache<T>(
  cache: KeyValueCache,
  options: { schema: z.ZodType<T>; prefix: string; ttlSec: number },
): JsonCache<T> {
  assertCacheTtl(options.ttlSec);
  const scoped = prefixedCache(cache, options.prefix);
  const read = async (key: string): Promise<T | null> => {
    const raw = await scoped.get(key);
    if (raw === null) return null;
    try {
      const parsed = options.schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: T) =>
    scoped.set(key, JSON.stringify(value), { ttlSec: options.ttlSec });

  return {
    get: read,
    set: write,
    delete: (key) => scoped.delete(key),
    async getOrLoad(key, load) {
      const cached = await read(key);
      if (cached !== null) return cached;
      const value = await load();
      await write(key, value);
      return value;
    },
  };
}
