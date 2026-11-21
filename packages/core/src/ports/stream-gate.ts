/** A playback slot held by one device of an account. Times are epoch milliseconds. */
export interface StreamLease {
  accountId: string;
  playbackSessionId: string;
  /** The auth session (device) holding the slot: one slot per device. */
  deviceId: string;
  /** Shown in the "too many screens" screen, e.g. "Chrome on macOS". */
  deviceLabel: string;
  titleName: string | null;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
}

export interface AcquireStreamRequest {
  accountId: string;
  playbackSessionId: string;
  deviceId: string;
  deviceLabel: string;
  titleName: string | null;
  /** The plan's concurrent stream limit at the time of the request. */
  limit: number;
  /** Lease lifetime without a renewal (heartbeat interval x 2 + grace, chosen by the caller). */
  leaseTtlSec: number;
}

export type AcquireStreamResult =
  | {
      ok: true;
      lease: StreamLease;
      /** Playback session this device held before, now released; null if none. */
      replaced: string | null;
    }
  | {
      ok: false;
      /** Live leases of the account (for the "too many screens" device list). */
      active: StreamLease[];
    };

/**
 * Port: concurrent-stream limiting per account (memory / Valkey / one Durable Object per
 * account). Every operation is scoped to one account, which maps 1:1 to a Durable Object.
 *
 * Contract:
 * - `acquire` is atomic per account: concurrent acquires never exceed `limit`.
 * - A device holds at most one lease. Acquiring for a device that already holds one replaces
 *   it (reported in `replaced`) and does not count against the limit.
 * - Re-acquiring an existing `playbackSessionId` is idempotent (renews it).
 * - Leases not renewed within `leaseTtlSec` expire and stop counting.
 * - Reads are strongly consistent (never back this port with Workers KV).
 */
export interface StreamGate {
  acquire(request: AcquireStreamRequest): Promise<AcquireStreamResult>;
  /** Extend a lease. Returns null when it no longer exists (expired or released): stop playback. */
  renew(
    accountId: string,
    playbackSessionId: string,
    leaseTtlSec: number,
  ): Promise<StreamLease | null>;
  /** Idempotent. */
  release(accountId: string, playbackSessionId: string): Promise<void>;
  /** End the lease held by one device (sign-out of that device). Idempotent. */
  releaseDevice(accountId: string, deviceId: string): Promise<void>;
  /** End every lease of the account (sign out of all devices). Idempotent. */
  releaseAll(accountId: string): Promise<void>;
  /** Live leases, oldest first. */
  list(accountId: string): Promise<StreamLease[]>;
}

export function assertAcquireRequest(request: AcquireStreamRequest): void {
  if (!Number.isInteger(request.limit) || request.limit < 1) {
    throw new RangeError("Stream limit must be a positive integer");
  }
  assertLeaseTtl(request.leaseTtlSec);
}

export function assertLeaseTtl(leaseTtlSec: number): void {
  if (!Number.isInteger(leaseTtlSec) || leaseTtlSec < 1) {
    throw new RangeError("leaseTtlSec must be a positive integer");
  }
}
