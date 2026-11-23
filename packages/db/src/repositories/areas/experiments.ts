import type { ExperimentDefinition } from "@webflix/contracts";
import type { AuditRecord, ExperimentsRepository, StoredExperiment } from "@webflix/core";
import { type Expression, type Kysely, sql } from "kysely";
import type { Database } from "../../database.ts";
import type { DB } from "../../schema.ts";
import type { AuditLogTable } from "../../tables/admin.ts";
import type { ExperimentsTable } from "../../tables/experiments.ts";
import { json, jsonOrNull, parseJson } from "../mapping.ts";

const iso = (value: number | null): string | null =>
  value === null ? null : new Date(Number(value)).toISOString();
const epoch = (value: string | null): number | null => (value === null ? null : Date.parse(value));

function toStored(row: ExperimentsTable): StoredExperiment {
  return {
    version: Number(row.version),
    definition: {
      key: row.key,
      name: row.name,
      description: row.description,
      status: row.status as ExperimentDefinition["status"],
      statusChangeAt: iso(row.status_change_at),
      previousStatus: row.previous_status as ExperimentDefinition["previousStatus"],
      unit: row.unit as ExperimentDefinition["unit"],
      layer: row.layer,
      allocation: { start: Number(row.allocation_start), end: Number(row.allocation_end) },
      salt: row.salt,
      targeting: parseJson(row.targeting_json),
      variants: parseJson(row.variants_json),
      control: row.control,
      primaryMetric: row.primary_metric as ExperimentDefinition["primaryMetric"],
      secondaryMetrics: parseJson(row.secondary_metrics_json),
      alpha: Number(row.alpha),
      power: row.power === null ? null : Number(row.power),
      minimumDetectableEffect: Number(row.minimum_detectable_effect),
      srmThreshold: row.srm_threshold === null ? null : Number(row.srm_threshold),
      startsAt: iso(row.starts_at),
      endsAt: iso(row.ends_at),
      registeredAt: iso(row.registered_at),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
    },
  };
}

function toRow(definition: ExperimentDefinition, version: number): ExperimentsTable {
  return {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    status: definition.status,
    unit: definition.unit,
    layer: definition.layer,
    allocation_start: definition.allocation.start,
    allocation_end: definition.allocation.end,
    salt: definition.salt,
    targeting_json: json(definition.targeting),
    variants_json: json(definition.variants),
    control: definition.control,
    primary_metric: definition.primaryMetric,
    secondary_metrics_json: json(definition.secondaryMetrics),
    alpha: definition.alpha,
    power: definition.power,
    minimum_detectable_effect: definition.minimumDetectableEffect,
    srm_threshold: definition.srmThreshold,
    starts_at: epoch(definition.startsAt),
    ends_at: epoch(definition.endsAt),
    registered_at: epoch(definition.registeredAt),
    version,
    previous_status: definition.previousStatus,
    status_change_at: epoch(definition.statusChangeAt),
    created_at: Date.parse(definition.createdAt),
    updated_at: Date.parse(definition.updatedAt),
  };
}

/** The `audit_log` row of an `AuditRecord` (admin's table, written in the changing batch). */
export function auditLogRow(record: AuditRecord): AuditLogTable {
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
  };
}

/**
 * An audit row inserted only if `query` finds a row (or, with `absent`, finds none) when the
 * statement runs. Put it first in the batch of the change it records, conditioned on the same
 * state the change is: the batch is atomic, so a change that writes nothing (a taken key, a
 * lost version race) leaves no audit entry. `INSERT ... SELECT <values> WHERE [NOT] EXISTS`.
 */
export function conditionalAuditInsert(
  database: Database,
  record: AuditRecord,
  query: (db: Kysely<DB>) => Expression<unknown>,
  absent = false,
) {
  const row = auditLogRow(record);
  const columns = Object.keys(row) as (keyof AuditLogTable)[];
  const { db } = database;
  const value = (column: keyof AuditLogTable) => {
    const raw = row[column];
    if (raw === null) return sql`null`;
    if (column === "created_at") {
      return sql`cast(${raw} as ${sql.raw(database.dialect === "postgres" ? "bigint" : "integer")})`;
    }
    return sql`cast(${raw} as text)`;
  };
  const exists = sql<boolean>`exists ${query(db)}`;
  return db
    .insertInto("audit_log")
    .columns(columns)
    .expression(
      db
        .selectNoFrom(columns.map((column) => value(column).as(column)))
        .where(absent ? sql<boolean>`not ${exists}` : exists),
    );
}

/**
 * The experiments area's repository on every dialect (SQLite, PostgreSQL, D1). A write and its
 * audit row are one batch; versions guard concurrent staff edits.
 */
export function createExperimentsRepository(database: Database): ExperimentsRepository {
  const { db } = database;
  return {
    async listExperiments() {
      const rows = await db.selectFrom("experiments").selectAll().orderBy("key").execute();
      return rows.map(toStored);
    },

    async getExperiment(key) {
      const row = await db
        .selectFrom("experiments")
        .selectAll()
        .where("key", "=", key)
        .executeTakeFirst();
      return row ? toStored(row) : null;
    },

    async createExperiment(definition, audit) {
      // The audit row first, conditioned on the state before the change; the batch is atomic,
      // so both statements see the same state and either both write or neither does.
      const [, inserted] = await database.batch([
        conditionalAuditInsert(
          database,
          audit,
          (inner) =>
            inner.selectFrom("experiments").select("key").where("key", "=", definition.key),
          true,
        ),
        db
          .insertInto("experiments")
          .values(toRow(definition, 1))
          .onConflict((oc) => oc.column("key").doNothing()),
      ]);
      return inserted.numAffectedRows > 0;
    },

    async updateExperiment(definition, expectedVersion, audit) {
      const {
        key: _key,
        created_at: _createdAt,
        ...changes
      } = toRow(definition, expectedVersion + 1);
      const [, updated] = await database.batch([
        conditionalAuditInsert(database, audit, (inner) =>
          inner
            .selectFrom("experiments")
            .select("key")
            .where("key", "=", definition.key)
            .where("version", "=", expectedVersion),
        ),
        db
          .updateTable("experiments")
          .set(changes)
          .where("key", "=", definition.key)
          .where("version", "=", expectedVersion),
      ]);
      return updated.numAffectedRows > 0;
    },

    async latestResults(key) {
      const row = await db
        .selectFrom("experiment_results")
        .select(["computed_at", "report_json"])
        .where("experiment_key", "=", key)
        .orderBy("computed_at", "desc")
        .executeTakeFirst();
      return row
        ? { computedAt: Number(row.computed_at), report: parseJson(row.report_json) }
        : null;
    },

    async saveResults(key, report) {
      await db
        .insertInto("experiment_results")
        .values({
          experiment_key: key,
          computed_at: report.computedAt,
          report_json: json(report.report),
        })
        .onConflict((oc) =>
          oc
            .columns(["experiment_key", "computed_at"])
            .doUpdateSet({ report_json: json(report.report) }),
        )
        .execute();
    },

    async pruneResults(before, limit) {
      // The oldest first, then deleted by key: 2 bound parameters a row, 45 rows a statement.
      const rows = await db
        .selectFrom("experiment_results")
        .select(["experiment_key", "computed_at"])
        .where("computed_at", "<", before)
        .orderBy("computed_at")
        .orderBy("experiment_key")
        .limit(limit)
        .execute();
      for (let index = 0; index < rows.length; index += PRUNE_CHUNK) {
        const chunk = rows.slice(index, index + PRUNE_CHUNK);
        await db
          .deleteFrom("experiment_results")
          .where((eb) =>
            eb.or(
              chunk.map((row) =>
                eb.and([
                  eb("experiment_key", "=", row.experiment_key),
                  eb("computed_at", "=", row.computed_at),
                ]),
              ),
            ),
          )
          .execute();
      }
      return rows.length;
    },
  };
}

/** Reports deleted per statement (2 bound parameters each, under D1's 100). */
const PRUNE_CHUNK = 45;
