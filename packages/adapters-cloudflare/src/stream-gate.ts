import { DurableObject } from "cloudflare:workers";
import {
  type AcquireStreamRequest,
  type AcquireStreamResult,
  assertAcquireRequest,
  assertLeaseTtl,
  type Clock,
  type StreamGate,
  type StreamLease,
  systemClock,
} from "@webflix/core";

interface LeaseRow extends Record<string, SqlStorageValue> {
  playback_session_id: string;
  account_id: string;
  device_id: string;
  device_label: string;
  title_name: string | null;
  acquired_at: number;
  renewed_at: number;
  expires_at: number;
  /** `expires_at` on this object's clock, for the cleanup alarm. */
  expires_at_local: number;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS leases (
  playback_session_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_label TEXT NOT NULL,
  title_name TEXT,
  acquired_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  expires_at_local INTEGER NOT NULL
)`;

function toLease(row: LeaseRow): StreamLease {
  return {
    accountId: row.account_id,
    playbackSessionId: row.playback_session_id,
    deviceId: row.device_id,
    deviceLabel: row.device_label,
    titleName: row.title_name,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
  };
}

/**
 * The stream slots of ONE account (blueprint §2.1: one Durable Object per account).
 *
 * Every method is synchronous over the SQLite storage API and wrapped in `transactionSync`:
 * nothing can interleave with an `acquire` (the object is single-threaded and the method never
 * yields), so concurrent "start playback" requests from every device of the account are
 * serialised here and can never exceed the plan's limit. The output gate holds each answer
 * until its write is durable, so a granted slot survives a crash or eviction.
 *
 * Expiry is evaluated against the caller's `now` (the contract suite drives it with a
 * `ManualClock`). An alarm at the earliest expiry deletes dead leases, and an account with no
 * live lease keeps no storage at all.
 */
export class StreamGateObject extends DurableObject {
  acquire(request: AcquireStreamRequest, now: number): AcquireStreamResult {
    assertAcquireRequest(request);
    const result = this.ctx.storage.transactionSync((): AcquireStreamResult => {
      const leases = this.live(now);
      const expiresAt = now + request.leaseTtlSec * 1000;
      const local = Date.now() + request.leaseTtlSec * 1000;

      const existing = leases.find(
        (lease) => lease.playbackSessionId === request.playbackSessionId,
      );
      if (existing) {
        this.exec(
          "UPDATE leases SET renewed_at = ?, expires_at = ?, expires_at_local = ? WHERE playback_session_id = ?",
          now,
          expiresAt,
          local,
          existing.playbackSessionId,
        );
        return { ok: true, lease: { ...existing, renewedAt: now, expiresAt }, replaced: null };
      }

      const sameDevice = leases.find((lease) => lease.deviceId === request.deviceId);
      const others = leases.length - (sameDevice ? 1 : 0);
      if (others >= request.limit) return { ok: false, active: leases };
      if (sameDevice) {
        this.exec("DELETE FROM leases WHERE playback_session_id = ?", sameDevice.playbackSessionId);
      }
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
      this.exec(
        `INSERT INTO leases (playback_session_id, account_id, device_id, device_label, title_name,
           acquired_at, renewed_at, expires_at, expires_at_local) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        lease.playbackSessionId,
        lease.accountId,
        lease.deviceId,
        lease.deviceLabel,
        lease.titleName,
        now,
        now,
        expiresAt,
        local,
      );
      return { ok: true, lease, replaced: sameDevice?.playbackSessionId ?? null };
    });
    if (result.ok) this.scheduleCleanup();
    return result;
  }

  renew(playbackSessionId: string, leaseTtlSec: number, now: number): StreamLease | null {
    assertLeaseTtl(leaseTtlSec);
    const renewed = this.ctx.storage.transactionSync(() => {
      const lease = this.live(now).find((entry) => entry.playbackSessionId === playbackSessionId);
      if (!lease) return null;
      const expiresAt = now + leaseTtlSec * 1000;
      this.exec(
        "UPDATE leases SET renewed_at = ?, expires_at = ?, expires_at_local = ? WHERE playback_session_id = ?",
        now,
        expiresAt,
        Date.now() + leaseTtlSec * 1000,
        playbackSessionId,
      );
      return { ...lease, renewedAt: now, expiresAt };
    });
    if (renewed) this.scheduleCleanup();
    return renewed;
  }

  async release(playbackSessionId: string): Promise<void> {
    this.exec("DELETE FROM leases WHERE playback_session_id = ?", playbackSessionId);
    await this.compact();
  }

  async releaseDevice(deviceId: string): Promise<void> {
    this.exec("DELETE FROM leases WHERE device_id = ?", deviceId);
    await this.compact();
  }

  async releaseAll(): Promise<void> {
    this.exec("DELETE FROM leases");
    await this.compact();
  }

  list(now: number): StreamLease[] {
    return this.live(now);
  }

  override async alarm(): Promise<void> {
    this.exec("DELETE FROM leases WHERE expires_at_local <= ?", Date.now());
    await this.compact();
  }

  /** Live leases, oldest first, as seen at `now` (expired rows are left for the alarm). */
  private live(now: number): StreamLease[] {
    this.ensureSchema();
    return this.ctx.storage.sql
      .exec<LeaseRow>(
        "SELECT * FROM leases WHERE expires_at > ? ORDER BY acquired_at, playback_session_id",
        now,
      )
      .toArray()
      .map(toLease);
  }

  private exec(query: string, ...bindings: SqlStorageValue[]): void {
    this.ensureSchema();
    this.ctx.storage.sql.exec(query, ...bindings);
  }

  private ensureSchema(): void {
    // Idempotent and cheap; needed again after `deleteAll()` dropped the table.
    this.ctx.storage.sql.exec(SCHEMA);
  }

  /** Arm the alarm for the earliest expiry, on this object's clock. */
  private scheduleCleanup(): void {
    const next = this.ctx.storage.sql
      .exec<{ next: number | null }>("SELECT min(expires_at_local) AS next FROM leases")
      .one().next;
    // Not awaited: the output gate holds the reply until the alarm write has committed.
    if (next !== null) void this.ctx.storage.setAlarm(next);
  }

  /**
   * Re-arm for the remaining leases, or, when none is left, drop all storage so an idle
   * account costs nothing. Awaited: the input gate then keeps the next request out until the
   * deletion is done, so it can never wipe a lease granted right after.
   */
  private async compact(): Promise<void> {
    const count = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM leases")
      .one().n;
    if (count > 0) {
      this.scheduleCleanup();
      return;
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export interface DurableObjectStreamGateOptions {
  /** Time source passed to the objects. Default: the system clock. */
  clock?: Clock;
}

/** `StreamGate` backed by `StreamGateObject`, one object per account. */
export function createDurableObjectStreamGate(
  namespace: DurableObjectNamespace<StreamGateObject>,
  options: DurableObjectStreamGateOptions = {},
): StreamGate {
  const clock = options.clock ?? systemClock;
  const gate = (accountId: string) => namespace.getByName(accountId);
  return {
    async acquire(request) {
      assertAcquireRequest(request);
      return gate(request.accountId).acquire({ ...request }, clock.now());
    },
    async renew(accountId, playbackSessionId, leaseTtlSec) {
      assertLeaseTtl(leaseTtlSec);
      return gate(accountId).renew(playbackSessionId, leaseTtlSec, clock.now());
    },
    async release(accountId, playbackSessionId) {
      await gate(accountId).release(playbackSessionId);
    },
    async releaseDevice(accountId, deviceId) {
      await gate(accountId).releaseDevice(deviceId);
    },
    async releaseAll(accountId) {
      await gate(accountId).releaseAll();
    },
    async list(accountId) {
      return gate(accountId).list(clock.now());
    },
  };
}
