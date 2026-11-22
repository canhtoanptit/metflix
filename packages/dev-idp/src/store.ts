/**
 * Where the issuer keeps the little state it cannot seal into the artefacts it hands out:
 * which codes and refresh tokens were already used, which grants and sessions were revoked.
 */

/** Port: the current time, structurally identical to `Clock` in `@webflix/core`. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * Port: an atomic set of expiring markers. Every key the issuer writes is namespaced by issuer.
 *
 * Contract: `claim` is an atomic insert-if-absent. Across every instance that shares the store,
 * exactly one concurrent `claim` of a key resolves `true` until the marker expires; `has` sees a
 * claimed marker immediately (read-after-write). An eventually consistent backend cannot honour
 * this: on Cloudflare use a Durable Object (as the `RateLimiter` adapter does), on Kubernetes
 * PostgreSQL (`INSERT ... ON CONFLICT DO NOTHING`) or Valkey (`SET key 1 NX PXAT expiresAt`).
 * Never Workers KV or the `KeyValueCache` port, which are eventually consistent.
 */
export interface DevIdpStore {
  /** Records `key` until `expiresAt` (epoch ms). True when this call created the marker. */
  claim(key: string, expiresAt: number): Promise<boolean>;
  /** True while a marker for `key` exists and has not expired. */
  has(key: string): Promise<boolean>;
}

/**
 * The default store: exact within one process (one Node process, or one Workers isolate). Expired
 * markers are swept as new ones are written, so memory stays bounded by what is live.
 */
export class MemoryDevIdpStore implements DevIdpStore {
  private readonly markers = new Map<string, number>();
  private readonly clock: Clock;
  private writesSinceSweep = 0;

  constructor(options: { clock?: Clock } = {}) {
    this.clock = options.clock ?? systemClock;
  }

  async claim(key: string, expiresAt: number): Promise<boolean> {
    const now = this.clock.now();
    const existing = this.markers.get(key);
    if (existing !== undefined && existing > now) return false;
    this.markers.set(key, expiresAt);
    this.writesSinceSweep += 1;
    if (this.writesSinceSweep >= 256) this.sweep(now);
    return true;
  }

  async has(key: string): Promise<boolean> {
    const expiresAt = this.markers.get(key);
    return expiresAt !== undefined && expiresAt > this.clock.now();
  }

  /** Live markers, for tests. */
  get size(): number {
    const now = this.clock.now();
    let live = 0;
    for (const expiresAt of this.markers.values()) if (expiresAt > now) live += 1;
    return live;
  }

  private sweep(now: number): void {
    this.writesSinceSweep = 0;
    for (const [key, expiresAt] of this.markers) if (expiresAt <= now) this.markers.delete(key);
  }
}
