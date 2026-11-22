import type { AuditOutcome } from "@webflix/contracts";
import type { AdminRepository, AuditLogRecord, DeadLetterRecord } from "@webflix/core";
import type { Selectable } from "kysely";
import type { Database } from "../../database.ts";
import type { AdminTables, JobDeadLettersTable } from "../../tables/admin.ts";
import { json, jsonOrNull, parseJson, parseJsonOrNull } from "../mapping.ts";

type AuditRow = Selectable<AdminTables["audit_log"]>;

const OUTCOMES: readonly AuditOutcome[] = ["pending", "succeeded", "failed", "unknown"];

/** A null outcome is a row written before the column existed, or by a batch that omits it. */
function outcomeOf(value: string | null): AuditOutcome {
  return OUTCOMES.includes(value as AuditOutcome) ? (value as AuditOutcome) : "succeeded";
}

function toAudit(row: AuditRow): AuditLogRecord {
  return {
    id: row.id,
    actor: {
      type: row.actor_type as AuditLogRecord["actor"]["type"],
      id: row.actor_id,
      name: row.actor_name,
    },
    action: row.action,
    target: { type: row.target_type, id: row.target_id },
    before: parseJsonOrNull(row.before_json),
    after: parseJsonOrNull(row.after_json),
    reason: row.reason,
    requestId: row.request_id,
    createdAt: Number(row.created_at),
    outcome: outcomeOf(row.outcome),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    idempotencyKey: row.idempotency_key,
  };
}

function fromAudit(record: AuditLogRecord) {
  return {
    id: record.id,
    actor_type: record.actor.type,
    actor_id: record.actor.id,
    actor_name: record.actor.name,
    action: record.action,
    target_type: record.target.type,
    target_id: record.target.id,
    before_json: jsonOrNull(record.before),
    after_json: jsonOrNull(record.after),
    reason: record.reason,
    request_id: record.requestId,
    created_at: record.createdAt,
    outcome: record.outcome,
    completed_at: record.completedAt,
    idempotency_key: record.idempotencyKey,
  };
}

function toDeadLetter(row: JobDeadLettersTable): DeadLetterRecord {
  return {
    id: row.id,
    jobType: row.job_type,
    payload: parseJson(row.payload_json),
    attempts: Number(row.attempts),
    lastError: row.last_error,
    failedAt: Number(row.failed_at),
    replayedAt: row.replayed_at === null ? null : Number(row.replayed_at),
  };
}

/**
 * The admin area's repository on every dialect (SQLite, PostgreSQL, D1), over its tables
 * (`tables/admin.ts`). Every write is one statement; conditions live in SQL, so concurrent
 * requests (two retries with one idempotency key, two replays of one dead letter) cannot both
 * win on any dialect.
 */
export function createAdminRepository(database: Database): AdminRepository {
  const { db } = database;

  return {
    async beginAudit(record) {
      // The unique index on idempotency_key decides between concurrent retries.
      const [inserted] = await database.batch([
        db
          .insertInto("audit_log")
          .values(fromAudit(record))
          .onConflict((oc) => oc.column("idempotency_key").doNothing()),
      ]);
      return inserted.numAffectedRows > 0;
    },

    async settleAudit(id, settlement) {
      const [updated] = await database.batch([
        db
          .updateTable("audit_log")
          .set({
            outcome: settlement.outcome,
            after_json: jsonOrNull(settlement.after),
            completed_at: settlement.completedAt,
          })
          .where("id", "=", id)
          .where("outcome", "in", ["pending", "unknown"]),
      ]);
      return updated.numAffectedRows > 0;
    },

    async appendAudit(record) {
      await db.insertInto("audit_log").values(fromAudit(record)).execute();
    },

    async getAudit(id) {
      const row = await db
        .selectFrom("audit_log")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? toAudit(row) : null;
    },

    async getAuditByIdempotencyKey(key) {
      const row = await db
        .selectFrom("audit_log")
        .selectAll()
        .where("idempotency_key", "=", key)
        .executeTakeFirst();
      return row ? toAudit(row) : null;
    },

    async listAudit(filter, { before, limit }) {
      let query = db.selectFrom("audit_log").selectAll();
      if (filter.actorId !== undefined) query = query.where("actor_id", "=", filter.actorId);
      if (filter.targetType !== undefined) {
        query = query.where("target_type", "=", filter.targetType);
      }
      if (filter.targetId !== undefined) query = query.where("target_id", "=", filter.targetId);
      if (filter.requestId !== undefined) {
        query = query.where("request_id", "=", filter.requestId);
      }
      if (filter.outcome !== undefined) {
        // Rows written before the column had a value read as `succeeded`.
        const outcome = filter.outcome;
        query =
          outcome === "succeeded"
            ? query.where((eb) => eb.or([eb("outcome", "=", outcome), eb("outcome", "is", null)]))
            : query.where("outcome", "=", outcome);
      }
      if (before !== null) {
        query = query.where((eb) =>
          eb.or([
            eb("created_at", "<", before.createdAt),
            eb.and([eb("created_at", "=", before.createdAt), eb("id", "<", before.id)]),
          ]),
        );
      }
      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map(toAudit);
    },

    async expirePendingAudit(cutoff, completedAt, limit) {
      const stale = await db
        .selectFrom("audit_log")
        .select("id")
        .where("outcome", "=", "pending")
        .where("created_at", "<", cutoff)
        .orderBy("created_at")
        .limit(Math.min(limit, 90))
        .execute();
      if (stale.length === 0) return 0;
      const [updated] = await database.batch([
        db
          .updateTable("audit_log")
          .set({ outcome: "unknown", completed_at: completedAt })
          .where(
            "id",
            "in",
            stale.map((row) => row.id),
          )
          // Settled meanwhile: leave it.
          .where("outcome", "=", "pending"),
      ]);
      return updated.numAffectedRows;
    },

    async saveDeadLetter(record) {
      await db
        .insertInto("job_dead_letters")
        .values({
          id: record.id,
          job_type: record.jobType,
          payload_json: json(record.payload),
          attempts: record.attempts,
          last_error: record.lastError,
          failed_at: record.failedAt,
          replayed_at: record.replayedAt,
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
    },

    async getDeadLetter(id) {
      const row = await db
        .selectFrom("job_dead_letters")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? toDeadLetter(row) : null;
    },

    async listDeadLetters({ before, limit }) {
      let query = db.selectFrom("job_dead_letters").selectAll();
      if (before !== null) {
        query = query.where((eb) =>
          eb.or([
            eb("failed_at", "<", before.failedAt),
            eb.and([eb("failed_at", "=", before.failedAt), eb("id", "<", before.id)]),
          ]),
        );
      }
      const rows = await query
        .orderBy("failed_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map(toDeadLetter);
    },

    async countDeadLetters() {
      const row = await db
        .selectFrom("job_dead_letters")
        .select((eb) => eb.fn.countAll<number | string>().as("count"))
        .where("replayed_at", "is", null)
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },

    async claimDeadLetterReplay(id, at) {
      const [updated] = await database.batch([
        db
          .updateTable("job_dead_letters")
          .set({ replayed_at: at })
          .where("id", "=", id)
          .where("replayed_at", "is", null),
      ]);
      return updated.numAffectedRows > 0;
    },

    async releaseDeadLetterReplay(id, at) {
      await db
        .updateTable("job_dead_letters")
        .set({ replayed_at: null })
        .where("id", "=", id)
        .where("replayed_at", "=", at)
        .execute();
    },
  };
}
