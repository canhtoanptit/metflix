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
  requestId?: string | undefined;
  /** `read`: the actions of `AUDIT_READ_ACTIONS`; `action`: every other. */
  kind?: "action" | "read" | undefined;
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

/**
 * What erasing a member does to the audit log:
 * - entries whose target is the member (`target`): the target id becomes `marker`, `before`
 *   and the free-text `reason` are dropped, `after` keeps only the error code an action ended
 *   with, and its idempotency key is dropped;
 * - every other entry: each of `identifiers` (the account id, its email address, its profiles'
 *   and privacy requests' ids), wherever it appears (target id, `before`, `after`, `reason`,
 *   case-insensitively), becomes `marker`.
 */
export interface AuditErasure {
  target: AuditLogRecord["target"];
  identifiers: readonly string[];
  /** `erased:<id>`: one per erased member, linking their entries to each other only. */
  marker: string;
}

/** Each identifier in `text` replaced by `marker`, case-insensitively. */
export function replaceIdentifiers(
  text: string,
  identifiers: readonly string[],
  marker: string,
): string {
  let result = text;
  for (const identifier of identifiers) {
    if (identifier === "") continue;
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), marker);
  }
  return result;
}

/** The entry of a member-targeted action after the member's erasure (see `AuditErasure`). */
export function erasedEntry(record: AuditLogRecord, marker: string): AuditLogRecord {
  const error = (record.after as { error?: unknown } | null)?.error;
  return {
    ...record,
    target: { type: record.target.type, id: marker },
    before: null,
    after: typeof error === "string" ? { error } : null,
    reason: null,
    // A client's key may embed anything; a retry after the erasure has nothing left to repeat.
    idempotencyKey: null,
  };
}

/** A key that mentions an identifier is dropped (keys are unique: a marker could collide). */
export function erasedKey(key: string | null, identifiers: readonly string[]): string | null {
  if (key === null) return null;
  const lowered = key.toLowerCase();
  return identifiers.some((id) => id !== "" && lowered.includes(id.toLowerCase())) ? null : key;
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
  /** Retention: entries written before `cutoff` deleted, at most `limit`; how many. */
  deleteAuditBefore(cutoff: number, limit: number): Promise<number>;
  /**
   * A member's erasure (`AuditErasure`): every entry about them keeps who acted, what, when and
   * how it ended, and nothing that identifies them. Idempotent; how many entries changed.
   */
  eraseAuditSubject(erasure: AuditErasure): Promise<number>;
  /** A member's erasure: dead letters whose payload mentions any identifier, deleted; how many. */
  deleteDeadLettersMentioning(identifiers: readonly string[]): Promise<number>;

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
