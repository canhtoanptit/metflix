import type {
  AdminRepository,
  AuditLogRecord,
  AuditPosition,
  DeadLetterPosition,
  DeadLetterRecord,
} from "../../areas/admin/repository.ts";
import type { AuditRecord } from "../../areas/experiments/audit.ts";

/** In-memory `AdminRepository`; `audit` and `deadLetters` expose the rows (tests). */
export interface MemoryAdminRepository extends AdminRepository {
  readonly audit: readonly AuditLogRecord[];
  readonly deadLetters: readonly DeadLetterRecord[];
}

const copy = <T>(value: T): T => structuredClone(value);

const newestFirst = (a: AuditPosition, b: AuditPosition) =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const olderThan = (row: AuditPosition, position: AuditPosition) =>
  row.createdAt < position.createdAt ||
  (row.createdAt === position.createdAt && row.id < position.id);

const deadNewestFirst = (a: DeadLetterPosition, b: DeadLetterPosition) =>
  b.failedAt - a.failedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * `alsoWrittenBy`: the audit rows other memory repositories keep (experiments, personalisation
 * write theirs in the same "batch" as their change, as on SQL, where they share `audit_log`), so
 * the log lists them too.
 */
export function createMemoryAdminRepository(
  options: { alsoWrittenBy?: () => readonly (readonly AuditRecord[])[] } = {},
): MemoryAdminRepository {
  const audit: AuditLogRecord[] = [];
  const written = (): AuditLogRecord[] => [
    ...audit,
    ...(options.alsoWrittenBy?.() ?? []).flat().map(
      (row): AuditLogRecord => ({
        ...row,
        outcome: "succeeded",
        completedAt: null,
        idempotencyKey: null,
      }),
    ),
  ];
  const deadLetters: DeadLetterRecord[] = [];
  const open = (record: AuditLogRecord) =>
    record.outcome === "pending" || record.outcome === "unknown";

  return {
    audit,
    deadLetters,

    async beginAudit(record) {
      if (
        record.idempotencyKey !== null &&
        audit.some((row) => row.idempotencyKey === record.idempotencyKey)
      ) {
        return false;
      }
      audit.push(copy(record));
      return true;
    },

    async settleAudit(id, settlement) {
      const row = audit.find((candidate) => candidate.id === id);
      if (!row || !open(row)) return false;
      row.outcome = settlement.outcome;
      row.after = copy(settlement.after);
      row.completedAt = settlement.completedAt;
      return true;
    },

    async appendAudit(record) {
      audit.push(copy(record));
    },

    async getAudit(id) {
      const row = written().find((candidate) => candidate.id === id);
      return row ? copy(row) : null;
    },

    async getAuditByIdempotencyKey(key) {
      const row = audit.find((candidate) => candidate.idempotencyKey === key);
      return row ? copy(row) : null;
    },

    async listAudit(filter, { before, limit }) {
      return written()
        .filter(
          (row) =>
            (filter.actorId === undefined || row.actor.id === filter.actorId) &&
            (filter.targetType === undefined || row.target.type === filter.targetType) &&
            (filter.targetId === undefined || row.target.id === filter.targetId) &&
            (filter.outcome === undefined || row.outcome === filter.outcome) &&
            (before === null || olderThan(row, before)),
        )
        .sort(newestFirst)
        .slice(0, limit)
        .map(copy);
    },

    async expirePendingAudit(cutoff, completedAt, limit) {
      const stale = audit
        .filter((row) => row.outcome === "pending" && row.createdAt < cutoff)
        .slice(0, limit);
      for (const row of stale) {
        row.outcome = "unknown";
        row.completedAt = completedAt;
      }
      return stale.length;
    },

    async saveDeadLetter(record) {
      if (deadLetters.some((row) => row.id === record.id)) return;
      deadLetters.push(copy(record));
    },

    async getDeadLetter(id) {
      const row = deadLetters.find((candidate) => candidate.id === id);
      return row ? copy(row) : null;
    },

    async listDeadLetters({ before, limit }) {
      return deadLetters
        .filter(
          (row) =>
            before === null ||
            row.failedAt < before.failedAt ||
            (row.failedAt === before.failedAt && row.id < before.id),
        )
        .sort(deadNewestFirst)
        .slice(0, limit)
        .map(copy);
    },

    async countDeadLetters() {
      return deadLetters.filter((row) => row.replayedAt === null).length;
    },

    async claimDeadLetterReplay(id, at) {
      const row = deadLetters.find((candidate) => candidate.id === id);
      if (!row || row.replayedAt !== null) return false;
      row.replayedAt = at;
      return true;
    },

    async releaseDeadLetterReplay(id, at) {
      const row = deadLetters.find((candidate) => candidate.id === id);
      if (row && row.replayedAt === at) row.replayedAt = null;
    },
  };
}
