import {
  assertCacheKey,
  assertCacheTtl,
  assertCacheValue,
  type KeyValueCache,
} from "../ports/cache.ts";
import { type Clock, systemClock } from "../ports/clock.ts";

/** In-process `KeyValueCache` with TTL and a size cap (least recently written evicted first). */
export class MemoryKeyValueCache implements KeyValueCache {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  private readonly clock: Clock;
  private readonly maxEntries: number;

  constructor(options: { clock?: Clock; maxEntries?: number } = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  async get(key: string): Promise<string | null> {
    assertCacheKey(key);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, options: { ttlSec: number }): Promise<void> {
    assertCacheKey(key);
    assertCacheValue(value);
    assertCacheTtl(options.ttlSec);
    // Re-insert so Map order tracks write recency for eviction.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.clock.now() + options.ttlSec * 1000 });
    this.evict();
  }

  async delete(key: string): Promise<void> {
    assertCacheKey(key);
    this.entries.delete(key);
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    const now = this.clock.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}
