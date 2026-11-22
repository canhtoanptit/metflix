import type { AuditEntry, AuditOutcome, JsonValue } from "@webflix/contracts";

/**
 * One `audit_log` row as the admin area reads and writes it: the contract's entry with epoch-ms
 * times, its outcome and the console's idempotency key.
 */
export interface AuditLogRecord {
  id: string;
  actor: AuditEntry["actor"];
  /** Dotted, e.g. `billing.refund`. */
  action: string;
  target: AuditEntry["target"];
  before: JsonValue | null;
  after: JsonValue | null;
  reason: string | null;
  requestId: string | null;
  createdAt: number;
  outcome: AuditOutcome;
  completedAt: number | null;
  /** Unique when set (the staff console's key on billing actions). */
  idempotencyKey: string | null;
}

export interface AuditLogFilter {
  actorId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  outcome?: AuditOutcome | undefined;
}

/** Newest first: entries strictly older than this position (`createdAt`, then `id`). */
export interface AuditPosition {
  createdAt: number;
  id: string;
}

export interface AuditSettlement {
  outcome: Exclude<AuditOutcome, "pending">;
  after: JsonValue | null;
  completedAt: number;
}

/** A job that exhausted its attempts, kept so staff can see and replay it in every mode. */
export interface DeadLetterRecord {
  /** The delivery id (stable across redeliveries of one job). */
  id: string;
  jobType: string;
  payload: JsonValue;
  attempts: number;
  lastError: string | null;
  failedAt: number;
  replayedAt: number | null;
}

export interface DeadLetterPosition {
  failedAt: number;
  id: string;
}

/**
 * Repository port of the admin area: `audit_log` (also written by the experiments and
 * personalisation repositories, in the same batch as their change) and `job_dead_letters`
 * (migrations under `packages/db/src/migrations/admin/`).
 *
 * Implemented in memory by `packages/core/src/memory/areas/admin.ts` and on every dialect by
 * `packages/db/src/repositories/areas/admin.ts`; both pass `describeAdminRepositoryContract`
 * (`packages/core/src/testing/areas/admin.contract.ts`). The D1 rules hold: one statement or one
 * batch per method, at most 100 bound parameters per statement.
 */
export interface AdminRepository {
  /**
   * Writes an entry before its action runs (`outcome: pending`), claiming its idempotency key
   * when it has one. False, with nothing written, when another entry holds the key.
   */
  beginAudit(record: AuditLogRecord): Promise<boolean>;
  /**
   * Records how an action ended. Only an open entry is settled (`pending`, or `unknown` after the
   * sweep gave up on it, so a late answer still lands); false otherwise.
   */
  settleAudit(id: string, settlement: AuditSettlement): Promise<boolean>;
  /** Writes a complete entry (a read of member data, a refused change). */
  appendAudit(record: AuditLogRecord): Promise<void>;
  getAudit(id: string): Promise<AuditLogRecord | null>;
  getAuditByIdempotencyKey(key: string): Promise<AuditLogRecord | null>;
  /** Newest first, at most `limit` (≤ 100). */
  listAudit(
    filter: AuditLogFilter,
    page: { before: AuditPosition | null; limit: number },
  ): Promise<AuditLogRecord[]>;
  /**
   * Entries still `pending` that were written before `cutoff` (their process died, or never got
   * an answer): marked `unknown`, at most `limit`; how many.
   */
  expirePendingAudit(cutoff: number, completedAt: number, limit: number): Promise<number>;

  /** Records a dead letter; the same delivery recorded again changes nothing. */
  saveDeadLetter(record: DeadLetterRecord): Promise<void>;
  getDeadLetter(id: string): Promise<DeadLetterRecord | null>;
  /** Newest first, at most `limit` (≤ 100). */
  listDeadLetters(page: {
    before: DeadLetterPosition | null;
    limit: number;
  }): Promise<DeadLetterRecord[]>;
  /** Dead letters not replayed yet. */
  countDeadLetters(): Promise<number>;
  /** Marks a dead letter replayed at `at` unless it already was; false then. */
  claimDeadLetterReplay(id: string, at: number): Promise<boolean>;
  /** Undoes `claimDeadLetterReplay(id, at)` when publishing the job failed. */
  releaseDeadLetterReplay(id: string, at: number): Promise<void>;
}
