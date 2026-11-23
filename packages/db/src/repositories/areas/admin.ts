import { AUDIT_READ_ACTIONS, type AuditOutcome } from "@webflix/contracts";
import {
  type AdminRepository,
  type AuditLogRecord,
  type DeadLetterRecord,
  erasedEntry,
  erasedKey,
  replaceIdentifiers,
} from "@webflix/core";
import { type Expression, type Selectable, sql } from "kysely";
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
/** Identifiers per statement: each is bound five times (key, target, before, after, reason). */
const IDENTIFIER_CHUNK = 18;
const ERASURE_PAGE = 100;

export function createAdminRepository(database: Database): AdminRepository {
  const { db } = database;

  /** `lower(column)` contains `value` (already lower-case), on every dialect, no LIKE limits. */
  const contains = (column: string, value: string): Expression<boolean> =>
    database.dialect === "postgres"
      ? sql<boolean>`strpos(lower(${sql.ref(column)}), ${value}) > 0`
      : sql<boolean>`instr(lower(${sql.ref(column)}), ${value}) > 0`;

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
      if (filter.kind === "read") query = query.where("action", "in", [...AUDIT_READ_ACTIONS]);
      if (filter.kind === "action") {
        query = query.where("action", "not in", [...AUDIT_READ_ACTIONS]);
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

    async deleteAuditBefore(cutoff, limit) {
      let deleted = 0;
      while (deleted < limit) {
        const rows = await db
          .selectFrom("audit_log")
          .select("id")
          .where("created_at", "<", cutoff)
          .orderBy("created_at")
          .limit(Math.min(90, limit - deleted))
          .execute();
        if (rows.length === 0) break;
        const [result] = await database.batch([
          db.deleteFrom("audit_log").where(
            "id",
            "in",
            rows.map((row) => row.id),
          ),
        ]);
        deleted += result.numAffectedRows;
        if (rows.length < 90) break;
      }
      return deleted;
    },

    async eraseAuditSubject({ target, identifiers, marker }) {
      const lowered = [
        ...new Set(identifiers.filter((id) => id !== "").map((id) => id.toLowerCase())),
      ];
      let changed = 0;
      const chunks: string[][] = [];
      for (let index = 0; index < Math.max(lowered.length, 1); index += IDENTIFIER_CHUNK) {
        chunks.push(lowered.slice(index, index + IDENTIFIER_CHUNK));
      }
      for (const chunk of chunks) {
        let after = "";
        for (;;) {
          const rows = await db
            .selectFrom("audit_log")
            .selectAll()
            .where("id", ">", after)
            .where((eb) =>
              eb.or([
                eb.and([eb("target_type", "=", target.type), eb("target_id", "=", target.id)]),
                ...chunk.flatMap((value) => [
                  contains("idempotency_key", value),
                  contains("target_id", value),
                  contains("before_json", value),
                  contains("after_json", value),
                  contains("reason", value),
                ]),
              ]),
            )
            .orderBy("id")
            .limit(ERASURE_PAGE)
            .execute();
          if (rows.length === 0) break;
          const updates = [];
          for (const row of rows) {
            const record = toAudit(row);
            const about = record.target.type === target.type && record.target.id === target.id;
            const next: AuditLogRecord = about
              ? erasedEntry(record, marker)
              : {
                  ...record,
                  target: {
                    type: record.target.type,
                    id: replaceIdentifiers(record.target.id, chunk, marker),
                  },
                  before:
                    row.before_json === null
                      ? null
                      : JSON.parse(replaceIdentifiers(row.before_json, chunk, marker)),
                  after:
                    row.after_json === null
                      ? null
                      : JSON.parse(replaceIdentifiers(row.after_json, chunk, marker)),
                  reason:
                    record.reason === null
                      ? null
                      : replaceIdentifiers(record.reason, chunk, marker),
                  idempotencyKey: erasedKey(record.idempotencyKey, chunk),
                };
            updates.push(
              db
                .updateTable("audit_log")
                .set({
                  target_id: next.target.id,
                  before_json: jsonOrNull(next.before),
                  after_json: jsonOrNull(next.after),
                  reason: next.reason,
                  idempotency_key: next.idempotencyKey,
                })
                .where("id", "=", row.id),
            );
          }
          await database.batch(updates);
          changed += rows.length;
          after = rows[rows.length - 1]?.id ?? after;
          if (rows.length < ERASURE_PAGE) break;
        }
      }
      return changed;
    },

    async deleteDeadLettersMentioning(identifiers) {
      const lowered = [
        ...new Set(identifiers.filter((id) => id !== "").map((id) => id.toLowerCase())),
      ];
      let deleted = 0;
      for (let index = 0; index < lowered.length; index += 80) {
        const chunk = lowered.slice(index, index + 80);
        const rows = await db
          .selectFrom("job_dead_letters")
          .select("id")
          .where((eb) => eb.or(chunk.map((value) => contains("payload_json", value))))
          .execute();
        for (let start = 0; start < rows.length; start += 90) {
          const ids = rows.slice(start, start + 90).map((row) => row.id);
          const [result] = await database.batch([
            db.deleteFrom("job_dead_letters").where("id", "in", ids),
          ]);
          deleted += result.numAffectedRows;
        }
      }
      return deleted;
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
