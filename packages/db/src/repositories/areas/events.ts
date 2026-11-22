import { CONSENT_PURPOSES } from "@webflix/contracts";
import {
  type ConsentRecord,
  type EventsRepository,
  OPEN_PRIVACY_STATUSES,
  type PrivacyErasureRecord,
  type PrivacyRequestRecord,
} from "@webflix/core";
import { type Database, isUniqueViolation } from "../../database.ts";
import type {
  ConsentsTable,
  PrivacyErasuresTable,
  PrivacyRequestsTable,
} from "../../tables/events.ts";
import { toPlaybackSession } from "../activity.ts";
import { fromBool, toBool, typed } from "../mapping.ts";

/** Erasure keys per statement: 4 bound parameters each, well within D1's 100. */
const ERASURE_CHUNK = 20;

function toConsent(row: ConsentsTable): ConsentRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    purpose: row.purpose as ConsentRecord["purpose"],
    granted: toBool(row.granted),
    source: row.source as ConsentRecord["source"],
    createdAt: Number(row.created_at),
  };
}

const nullableTime = (value: number | string | null) => (value === null ? null : Number(value));

function toPrivacyRequest(row: PrivacyRequestsTable): PrivacyRequestRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind as PrivacyRequestRecord["kind"],
    status: row.status as PrivacyRequestRecord["status"],
    requestedAt: Number(row.requested_at),
    scheduledFor: nullableTime(row.scheduled_for),
    completedAt: nullableTime(row.completed_at),
    exportBlobKey: row.export_blob_key,
    expiresAt: nullableTime(row.expires_at),
    lastError: row.last_error,
    updatedAt: Number(row.updated_at),
  };
}

function toErasure(row: PrivacyErasuresTable): PrivacyErasureRecord {
  return {
    subjectKey: row.subject_key,
    kind: row.kind as PrivacyErasureRecord["kind"],
    requestedAt: Number(row.requested_at),
    compactedAt: nullableTime(row.compacted_at),
  };
}

/**
 * The events area's repository on every dialect (SQLite, PostgreSQL, D1), over its tables
 * (`tables/events.ts`). Passes `describeEventsRepositoryContract` here and in workerd.
 */
export function createEventsRepository(database: Database): EventsRepository {
  const { db, dialect } = database;

  return {
    async addConsent(record) {
      await db
        .insertInto("consents")
        .values({
          id: record.id,
          account_id: record.accountId,
          purpose: record.purpose,
          granted: fromBool(record.granted),
          source: record.source,
          created_at: record.createdAt,
        })
        .execute();
    },

    async consentsAt(accountId, at) {
      // One statement: the latest answer of each purpose, as a UNION ALL of one-row subqueries.
      const latest = (purpose: string) =>
        db
          .selectFrom("consents")
          .selectAll()
          .where("account_id", "=", accountId)
          .where("purpose", "=", purpose)
          .where("created_at", "<=", at)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(1);
      const [first, ...rest] = CONSENT_PURPOSES.map((purpose, index) =>
        db.selectFrom(latest(purpose).as(`p${index}`)).selectAll(),
      );
      if (!first) return [];
      const query = rest.reduce((union, next) => union.unionAll(next), first);
      return (await query.execute()).map((row) => toConsent(row as ConsentsTable));
    },

    async listConsents(accountId) {
      const rows = await db
        .selectFrom("consents")
        .selectAll()
        .where("account_id", "=", accountId)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();
      return rows.map(toConsent);
    },

    async createPrivacyRequest(record) {
      // Insert only while no open request of the kind exists; the partial unique index
      // (0011_events_privacy_open) settles two concurrent inserts.
      try {
        const insert = db
          .insertInto("privacy_requests")
          .columns([
            "id",
            "account_id",
            "kind",
            "status",
            "requested_at",
            "scheduled_for",
            "completed_at",
            "export_blob_key",
            "expires_at",
            "last_error",
            "updated_at",
          ])
          .expression(
            db
              .selectNoFrom([
                typed(dialect, record.id, "text").as("id"),
                typed(dialect, record.accountId, "text").as("account_id"),
                typed(dialect, record.kind, "text").as("kind"),
                typed(dialect, record.status, "text").as("status"),
                typed(dialect, record.requestedAt, "time").as("requested_at"),
                typed(dialect, record.scheduledFor, "time").as("scheduled_for"),
                typed(dialect, record.completedAt, "time").as("completed_at"),
                typed(dialect, record.exportBlobKey, "text").as("export_blob_key"),
                typed(dialect, record.expiresAt, "time").as("expires_at"),
                typed(dialect, record.lastError, "text").as("last_error"),
                typed(dialect, record.updatedAt, "time").as("updated_at"),
              ])
              .where(({ not, exists, selectFrom }) =>
                not(
                  exists(
                    selectFrom("privacy_requests")
                      .select("id")
                      .where("account_id", "=", record.accountId)
                      .where("kind", "=", record.kind)
                      .where("status", "in", [...OPEN_PRIVACY_STATUSES]),
                  ),
                ),
              ),
          );
        const [result] = await database.batch([insert]);
        return result.numAffectedRows === 1;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },

    async getPrivacyRequest(id) {
      const row = await db
        .selectFrom("privacy_requests")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? toPrivacyRequest(row) : null;
    },

    async listPrivacyRequests(accountId) {
      const rows = await db
        .selectFrom("privacy_requests")
        .selectAll()
        .where("account_id", "=", accountId)
        .orderBy("requested_at", "desc")
        .orderBy("id", "desc")
        .execute();
      return rows.map(toPrivacyRequest);
    },

    async transitionPrivacyRequest(id, from, patch) {
      if (from.length === 0) return false;
      const set: Partial<PrivacyRequestsTable> = { updated_at: patch.updatedAt };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.scheduledFor !== undefined) set.scheduled_for = patch.scheduledFor;
      if (patch.completedAt !== undefined) set.completed_at = patch.completedAt;
      if (patch.exportBlobKey !== undefined) set.export_blob_key = patch.exportBlobKey;
      if (patch.expiresAt !== undefined) set.expires_at = patch.expiresAt;
      if (patch.lastError !== undefined) set.last_error = patch.lastError;
      const result = await db
        .updateTable("privacy_requests")
        .set(set)
        .where("id", "=", id)
        .where("status", "in", [...from])
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async dueDeletions(now, limit) {
      const rows = await db
        .selectFrom("privacy_requests")
        .selectAll()
        .where("status", "=", "scheduled")
        .where("kind", "=", "deletion")
        .where("scheduled_for", "<=", now)
        .orderBy("scheduled_for", "asc")
        .orderBy("id", "asc")
        .limit(limit)
        .execute();
      return rows.map(toPrivacyRequest);
    },

    async expiredExports(now, limit) {
      const rows = await db
        .selectFrom("privacy_requests")
        .selectAll()
        .where("kind", "=", "export")
        .where("export_blob_key", "is not", null)
        .where("expires_at", "<", now)
        .orderBy("expires_at", "asc")
        .orderBy("id", "asc")
        .limit(limit)
        .execute();
      return rows.map(toPrivacyRequest);
    },

    async addErasures(records) {
      for (let index = 0; index < records.length; index += ERASURE_CHUNK) {
        const chunk = records.slice(index, index + ERASURE_CHUNK);
        await db
          .insertInto("privacy_erasures")
          .values(
            chunk.map((record) => ({
              subject_key: record.subjectKey,
              kind: record.kind,
              requested_at: record.requestedAt,
              compacted_at: record.compactedAt,
            })),
          )
          .onConflict((oc) => oc.column("subject_key").doNothing())
          .execute();
      }
    },

    async pendingErasures(limit) {
      const rows = await db
        .selectFrom("privacy_erasures")
        .selectAll()
        .where("compacted_at", "is", null)
        .orderBy("requested_at", "asc")
        .orderBy("subject_key", "asc")
        .limit(limit)
        .execute();
      return rows.map(toErasure);
    },

    async markErasuresCompacted(subjectKeys, at) {
      for (let index = 0; index < subjectKeys.length; index += 90) {
        const chunk = subjectKeys.slice(index, index + 90);
        await db
          .updateTable("privacy_erasures")
          .set({ compacted_at: at })
          .where("subject_key", "in", chunk)
          .where("compacted_at", "is", null)
          .execute();
      }
    },

    async openPlaybackBefore(cutoff, limit) {
      const rows = await db
        .selectFrom("playback_sessions")
        .selectAll()
        .where("ended_at", "is", null)
        .where("last_heartbeat_at", "<", cutoff)
        .orderBy("last_heartbeat_at", "asc")
        .orderBy("id", "asc")
        .limit(limit)
        .execute();
      return rows.map(toPlaybackSession);
    },

    async takeOutbox(limit) {
      const rows = await db
        .selectFrom("event_outbox")
        .selectAll()
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        profileId: row.profile_id,
        payload: row.payload,
        createdAt: Number(row.created_at),
      }));
    },

    async deleteOutbox(ids) {
      for (let index = 0; index < ids.length; index += 90) {
        await db
          .deleteFrom("event_outbox")
          .where("id", "in", ids.slice(index, index + 90))
          .execute();
      }
    },

    async deleteAccount(accountId) {
      const [, deleted] = await database.batch([
        db.deleteFrom("event_outbox").where("account_id", "=", accountId),
        db.deleteFrom("accounts").where("id", "=", accountId),
      ]);
      return deleted.numAffectedRows > 0;
    },
  };
}
