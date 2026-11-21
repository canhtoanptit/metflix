import { describe, expect, it } from "vitest";
import {
  type KeyValueCache,
  MAX_CACHE_KEY_BYTES,
  MAX_CACHE_VALUE_BYTES,
  MIN_CACHE_TTL_SEC,
} from "../ports/cache.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

export interface KeyValueCacheHarness extends HarnessBase {
  cache: KeyValueCache;
}

/**
 * Contract every `KeyValueCache` adapter must pass. The cases read back their own writes from
 * the same client, which local emulators and a single KV location provide; application code
 * must still never rely on it (see the port).
 */
export function describeKeyValueCacheContract(
  name: string,
  factory: HarnessFactory<KeyValueCacheHarness>,
): void {
  describe(`KeyValueCache contract: ${name}`, () => {
    const h = useHarness(factory);
    const ttl = { ttlSec: MIN_CACHE_TTL_SEC };

    it("reads a missing key as null", async () => {
      expect(await h().cache.get("missing")).toBeNull();
    });

    it("returns what was set and overwrites", async () => {
      const { cache } = h();
      await cache.set("k", "one", ttl);
      expect(await cache.get("k")).toBe("one");
      await cache.set("k", "two", ttl);
      expect(await cache.get("k")).toBe("two");
    });

    it("deletes, and deleting a missing key is not an error", async () => {
      const { cache } = h();
      await cache.set("k", "v", ttl);
      await cache.delete("k");
      expect(await cache.get("k")).toBeNull();
      await expect(cache.delete("never-set")).resolves.toBeUndefined();
    });

    it("keeps keys independent and case-sensitive", async () => {
      const { cache } = h();
      await cache.set("Key", "upper", ttl);
      await cache.set("key", "lower", ttl);
      expect(await cache.get("Key")).toBe("upper");
      expect(await cache.get("key")).toBe("lower");
    });

    it("stores unicode and large values intact", async () => {
      const { cache } = h();
      const value = `héllo 😀 ${"x".repeat(100_000)}`;
      await cache.set("big", value, ttl);
      expect(await cache.get("big")).toBe(value);
      await cache.set("empty", "", ttl);
      expect(await cache.get("empty")).toBe("");
    });

    it(`rejects ttlSec below ${MIN_CACHE_TTL_SEC}`, async () => {
      await expect(h().cache.set("k", "v", { ttlSec: MIN_CACHE_TTL_SEC - 1 })).rejects.toThrow(
        RangeError,
      );
    });

    it("rejects empty and oversized keys and oversized values", async () => {
      const { cache } = h();
      await expect(cache.set("", "v", ttl)).rejects.toThrow();
      await expect(cache.set("k".repeat(MAX_CACHE_KEY_BYTES + 1), "v", ttl)).rejects.toThrow();
      await expect(cache.set("k", "v".repeat(MAX_CACHE_VALUE_BYTES + 1), ttl)).rejects.toThrow();
    });

    it("expires entries after ttlSec", async (context) => {
      const { cache, time } = h();
      if (!time) return context.skip();
      await cache.set("k", "v", { ttlSec: 120 });
      await time.advance(119_000);
      expect(await cache.get("k")).toBe("v");
      await time.advance(2_000);
      expect(await cache.get("k")).toBeNull();
    });
  });
}
