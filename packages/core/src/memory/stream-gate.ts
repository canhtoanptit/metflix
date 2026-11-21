import { type Clock, systemClock } from "../ports/clock.ts";
import {
  type AcquireStreamRequest,
  type AcquireStreamResult,
  assertAcquireRequest,
  assertLeaseTtl,
  type StreamGate,
  type StreamLease,
} from "../ports/stream-gate.ts";

const byAge = (a: StreamLease, b: StreamLease) =>
  a.acquiredAt - b.acquiredAt || a.playbackSessionId.localeCompare(b.playbackSessionId);

/**
 * In-process `StreamGate`. Each method runs without awaiting, so it is atomic on the single
 * JS thread; that is the same guarantee a Durable Object gives per account.
 */
export class MemoryStreamGate implements StreamGate {
  private readonly accounts = new Map<string, Map<string, StreamLease>>();
  private readonly clock: Clock;

  constructor(options: { clock?: Clock } = {}) {
    this.clock = options.clock ?? systemClock;
  }

  async acquire(request: AcquireStreamRequest): Promise<AcquireStreamResult> {
    assertAcquireRequest(request);
    const now = this.clock.now();
    const leases = this.live(request.accountId, now);
    const expiresAt = now + request.leaseTtlSec * 1000;

    const existing = leases.get(request.playbackSessionId);
    if (existing) {
      const lease = { ...existing, renewedAt: now, expiresAt };
      leases.set(lease.playbackSessionId, lease);
      return { ok: true, lease: { ...lease }, replaced: null };
    }

    const sameDevice = [...leases.values()].find((lease) => lease.deviceId === request.deviceId);
    const others = leases.size - (sameDevice ? 1 : 0);
    if (others >= request.limit) {
      return { ok: false, active: [...leases.values()].sort(byAge).map((lease) => ({ ...lease })) };
    }
    if (sameDevice) leases.delete(sameDevice.playbackSessionId);

    const lease: StreamLease = {
      accountId: request.accountId,
      playbackSessionId: request.playbackSessionId,
      deviceId: request.deviceId,
      deviceLabel: request.deviceLabel,
      titleName: request.titleName,
      acquiredAt: now,
      renewedAt: now,
      expiresAt,
    };
    leases.set(lease.playbackSessionId, lease);
    this.accounts.set(request.accountId, leases);
    return { ok: true, lease: { ...lease }, replaced: sameDevice?.playbackSessionId ?? null };
  }

  async renew(
    accountId: string,
    playbackSessionId: string,
    leaseTtlSec: number,
  ): Promise<StreamLease | null> {
    assertLeaseTtl(leaseTtlSec);
    const now = this.clock.now();
    const leases = this.live(accountId, now);
    const lease = leases.get(playbackSessionId);
    if (!lease) return null;
    const renewed = { ...lease, renewedAt: now, expiresAt: now + leaseTtlSec * 1000 };
    leases.set(playbackSessionId, renewed);
    return { ...renewed };
  }

  async release(accountId: string, playbackSessionId: string): Promise<void> {
    this.accounts.get(accountId)?.delete(playbackSessionId);
  }

  async releaseDevice(accountId: string, deviceId: string): Promise<void> {
    const leases = this.accounts.get(accountId);
    if (!leases) return;
    for (const [id, lease] of leases) {
      if (lease.deviceId === deviceId) leases.delete(id);
    }
  }

  async releaseAll(accountId: string): Promise<void> {
    this.accounts.delete(accountId);
  }

  async list(accountId: string): Promise<StreamLease[]> {
    return [...this.live(accountId, this.clock.now()).values()]
      .sort(byAge)
      .map((lease) => ({ ...lease }));
  }

  /** The account's leases with expired ones dropped. */
  private live(accountId: string, now: number): Map<string, StreamLease> {
    const leases = this.accounts.get(accountId) ?? new Map<string, StreamLease>();
    for (const [id, lease] of leases) {
      if (lease.expiresAt <= now) leases.delete(id);
    }
    if (leases.size === 0) this.accounts.delete(accountId);
    return leases;
  }
}
