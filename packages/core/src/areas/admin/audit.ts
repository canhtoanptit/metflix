/**
 * The audit trail of the staff API (milestone 2 §8.3): who acted, what, on whom, why, and with
 * what outcome.
 *
 * Two kinds of staff action:
 * - The experiments and personalisation areas write their audit row in the same batch as their
 *   change (given a `StaffAction`): the row and the change commit together or not at all. The
 *   staff API only adds an entry when such a call fails (`recordFailure`), so a refused attempt
 *   is visible too.
 * - The identity, billing and events areas (and the system actions) do not write the log. For
 *   them `audited()` writes the entry **before** calling the service, as `pending`, and settles
 *   it afterwards. If that first write fails, the action never runs. Whatever happens next (the
 *   call fails half-way, the provider never answers, the process dies, settling fails) the entry
 *   already exists, so the action cannot be observed without it; an entry nobody settled is
 *   turned `unknown` by the scheduled sweep (`sweepPendingAudit`).
 *
 * An idempotency key (the console's, on billing actions) is claimed by that same first write: a
 * retried request finds the first one's entry and is answered from it, never run again.
 */
import {
  AUDIT_READ_ACTIONS,
  type AuditLogEntry,
  type AuditOutcome,
  type AuditQuery,
  errorStatus,
  type JsonValue,
} from "@webflix/contracts";
import * as z from "zod";
import { decodeCursor, encodeCursor, invalidCursor } from "../../domain/cursor.ts";
import { AppError } from "../../errors.ts";
import { toIsoString } from "../../ports/clock.ts";
import { serializeError } from "../../ports/logger.ts";
import type { StaffIdentity } from "../../ports/staff-verifier.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import type { StaffAction } from "../experiments/audit.ts";
import { auditFacts } from "./facts.ts";
import type { AuditLogRecord } from "./repository.ts";

/** Who is acting and the request it came with (the HTTP layer fills it in). */
export interface StaffContext {
  staff: Pick<StaffIdentity, "subject" | "name" | "email">;
  requestId: string | null;
}

/** An entry nobody settled within this long is marked `unknown` by the sweep. */
export const PENDING_AUDIT_TIMEOUT_MS = 15 * 60 * 1000;
const SWEEP_BATCH = 500;
/** Entries deleted per sweep: bounded work per scheduler tick; a backlog drains over ticks. */
const RETENTION_BATCH = 900;
const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_AUDIT_PAGE = 50;

export function auditActor(staff: StaffContext["staff"]): AuditLogRecord["actor"] {
  return { type: "staff", id: staff.subject, name: staff.name ?? staff.email ?? null };
}

/** The `StaffAction` the self-auditing areas take (experiments, personalisation). */
export function staffAction(context: StaffContext, reason: string): StaffAction {
  return { actor: auditActor(context.staff), reason, requestId: context.requestId };
}

/** JSON with object keys sorted, so two equal requests compare equal whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** As JSON (drops `undefined`, which JSON columns cannot hold). */
export function asJson(value: unknown): JsonValue {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "internal_error";
}

/**
 * How an action that threw ended. A refusal (4xx) of a single-step action happened before
 * anything changed: `failed`. Anything else may or may not have changed something: `unknown`
 * (a timeout, the provider unreachable, a bug, or a multi-step action refused half-way).
 */
export function failureOutcome(error: unknown, singleStep: boolean): "failed" | "unknown" {
  if (error instanceof AppError && errorStatus(error.code) < 500) {
    return singleStep ? "failed" : "unknown";
  }
  return "unknown";
}

export interface AuditedAction<T> {
  context: StaffContext;
  /** Dotted, e.g. `billing.refund`. */
  action: string;
  target: AuditLogRecord["target"];
  reason: string;
  /**
   * What was asked (kept as `before.request`); a retry with the same idempotency key must ask
   * exactly this again.
   */
  parameters?: JsonValue;
  /** The target's state before, when cheap to read (kept as `before.state`). */
  state?: JsonValue | null;
  idempotencyKey?: string | undefined;
  run: () => Promise<T>;
  /** What to keep as `after` (default: the result). A retry is answered from it. */
  after?: (result: T) => JsonValue | null;
  /** Rebuilds the response of a succeeded first attempt from its `after` (default: as is). */
  replay?: (after: JsonValue | null) => T;
  /** False when a refusal can come after a first change (cancel now, then refund). */
  singleStep?: boolean;
}

export interface AuditTrail {
  audited<T>(spec: AuditedAction<T>): Promise<T>;
  /** A read of member data: written before the data is returned (no entry, no data). */
  recordRead(
    context: StaffContext,
    action: string,
    target: AuditLogRecord["target"],
    after?: JsonValue | null,
  ): Promise<void>;
  /** A change of a self-auditing area that failed; never throws (the area's error matters). */
  recordFailure(
    context: StaffContext,
    spec: {
      action: string;
      target: AuditLogRecord["target"];
      reason: string;
      parameters?: JsonValue;
      error: unknown;
    },
  ): Promise<void>;
  list(query: AuditQuery): Promise<{ items: AuditLogEntry[]; nextCursor: string | null }>;
  /**
   * The entries `subject` made, for a staff member without the admin role: `before` and `after`
   * withheld (they can hold member data the caller's role does not, or no longer, cover), except
   * the error code an action ended with (`after.error`).
   */
  listOwn(
    subject: string,
    query: Omit<AuditQuery, "actorId">,
  ): Promise<{ items: AuditLogEntry[]; nextCursor: string | null }>;
  /** Marks `unknown` what stayed `pending` past `PENDING_AUDIT_TIMEOUT_MS`; how many. */
  sweepPendingAudit(): Promise<number>;
  /** Deletes entries older than the retention period (`WEBFLIX_AUDIT_RETENTION_DAYS`); how many. */
  enforceRetention(): Promise<number>;
}

const AuditCursor = z.object({ c: z.number().int(), i: z.string().min(1).max(64) });

export function presentAuditEntry(record: AuditLogRecord): AuditLogEntry {
  return {
    id: record.id,
    actor: { ...record.actor },
    action: record.action,
    target: { ...record.target },
    before: record.before,
    after: record.after,
    reason: record.reason,
    requestId: record.requestId,
    createdAt: toIsoString(record.createdAt),
    outcome: record.outcome,
    completedAt: record.completedAt === null ? null : toIsoString(record.completedAt),
    kind: READ_ACTIONS.has(record.action) ? "read" : "action",
    // Resolved by the staff operations when the log is read (a member's current address).
    targetLabel: null,
    facts: auditFacts(record),
  };
}

const READ_ACTIONS: ReadonlySet<string> = new Set(AUDIT_READ_ACTIONS);

export function createAuditTrail(deps: ServiceDependencies): AuditTrail {
  const { repos, clock, ids, logger } = deps;
  const log = logger.child({ component: "admin.audit" });

  function entry(
    context: StaffContext,
    fields: Pick<AuditLogRecord, "action" | "target" | "before" | "after" | "reason"> & {
      outcome: AuditOutcome;
      idempotencyKey?: string | null;
    },
  ): AuditLogRecord {
    const now = clock.now();
    return {
      id: ids.next(),
      actor: auditActor(context.staff),
      action: fields.action,
      target: { ...fields.target },
      before: fields.before,
      after: fields.after,
      reason: fields.reason,
      requestId: context.requestId,
      createdAt: now,
      outcome: fields.outcome,
      completedAt: fields.outcome === "pending" ? null : now,
      idempotencyKey: fields.idempotencyKey ?? null,
    };
  }

  /** The answer to a retry: the first attempt's response, or why it cannot be given. */
  async function answerRetry<T>(spec: AuditedAction<T>, key: string): Promise<T> {
    const first = await repos.admin.getAuditByIdempotencyKey(key);
    if (!first) {
      // The key was claimed but its entry cannot be read back: never act a second time.
      throw new AppError("staff_action_conflict", {
        detail: "An earlier request used this idempotency key.",
      });
    }
    const asked = (first.before as { request?: unknown } | null)?.request ?? null;
    const same =
      first.action === spec.action &&
      first.target.type === spec.target.type &&
      first.target.id === spec.target.id &&
      first.actor.id === spec.context.staff.subject &&
      canonical(asked) === canonical(spec.parameters ?? null);
    if (!same) {
      throw new AppError("staff_action_conflict", {
        auditId: first.id,
        detail: `This idempotency key was used for another request (audit entry ${first.id}).`,
      });
    }
    if (first.outcome !== "succeeded") {
      throw new AppError("staff_action_conflict", {
        auditId: first.id,
        detail:
          first.outcome === "pending"
            ? `The first attempt with this key is still running (audit entry ${first.id}).`
            : `The first attempt with this key ended ${first.outcome} (audit entry ${first.id}): check the member before trying again with a new key.`,
      });
    }
    log.info("admin.idempotent_replay", { auditId: first.id, action: first.action });
    return spec.replay ? spec.replay(first.after) : (first.after as T);
  }

  async function listPage(
    query: AuditQuery,
  ): Promise<{ items: AuditLogEntry[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_AUDIT_PAGE;
    let before: { createdAt: number; id: string } | null = null;
    if (query.cursor !== undefined) {
      const decoded = decodeCursor(query.cursor, AuditCursor);
      if (!decoded) throw invalidCursor();
      before = { createdAt: decoded.c, id: decoded.i };
    }
    const rows = await repos.admin.listAudit(
      {
        actorId: query.actorId,
        targetType: query.targetType,
        targetId: query.targetId,
        outcome: query.outcome,
        requestId: query.requestId,
        kind: query.kind,
      },
      { before, limit: limit + 1 },
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(presentAuditEntry),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ c: last.createdAt, i: last.id }) : null,
    };
  }

  async function settle(
    id: string,
    outcome: Exclude<AuditOutcome, "pending">,
    after: JsonValue | null,
  ): Promise<void> {
    try {
      await repos.admin.settleAudit(id, { outcome, after, completedAt: clock.now() });
    } catch (error) {
      // The entry exists (pending): the sweep turns it `unknown`. The action's own result stands.
      log.error("admin.audit_settle_failed", {
        auditId: id,
        outcome,
        error: serializeError(error),
      });
    }
  }

  return {
    async audited<T>(spec: AuditedAction<T>): Promise<T> {
      const key = spec.idempotencyKey ?? null;
      const before: JsonValue = {
        request: spec.parameters ?? null,
        ...(spec.state === undefined ? {} : { state: spec.state }),
      };
      const pending = entry(spec.context, {
        action: spec.action,
        target: spec.target,
        before,
        after: null,
        reason: spec.reason,
        outcome: "pending",
        idempotencyKey: key,
      });
      // Written first: if this throws, the action does not run.
      const claimed = await repos.admin.beginAudit(pending);
      if (!claimed) {
        if (key === null) throw new Error("beginAudit refused an entry without a key");
        return answerRetry(spec, key);
      }
      let result: T;
      try {
        result = await spec.run();
      } catch (error) {
        await settle(pending.id, failureOutcome(error, spec.singleStep ?? true), {
          error: errorCode(error),
        });
        // A billing action (the ones with a key) that a dependency left unanswered may have
        // taken effect: the area's "try again in a moment" would invite a second attempt, so the
        // staff member is told what is known instead.
        if (key !== null && error instanceof AppError && error.code === "service_unavailable") {
          throw new AppError("service_unavailable", {
            detail: `This change could not be confirmed (a service did not answer in time), so it is not known whether it took effect: see audit entry ${pending.id}. Check the member before acting again. Sending this same request again with the same idempotency key never acts twice; a new key might.`,
            cause: error,
          });
        }
        throw error;
      }
      await settle(pending.id, "succeeded", spec.after ? spec.after(result) : asJson(result));
      return result;
    },

    async recordRead(context, action, target, after = null) {
      await repos.admin.appendAudit(
        entry(context, { action, target, before: null, after, reason: null, outcome: "succeeded" }),
      );
    },

    async recordFailure(context, spec) {
      try {
        await repos.admin.appendAudit(
          entry(context, {
            action: spec.action,
            target: spec.target,
            before: { request: spec.parameters ?? null },
            after: { error: errorCode(spec.error) },
            reason: spec.reason,
            outcome: failureOutcome(spec.error, true),
          }),
        );
      } catch (error) {
        log.error("admin.audit_failure_not_recorded", {
          action: spec.action,
          error: serializeError(error),
        });
      }
    },

    list: (query) => listPage(query),

    async listOwn(subject, query) {
      const page = await listPage({ ...query, actorId: subject });
      return {
        items: page.items.map((item) => {
          const error = (item.after as { error?: unknown } | null)?.error;
          return {
            ...item,
            before: null,
            after: typeof error === "string" ? { error } : null,
            facts: typeof error === "string" ? { error } : {},
          };
        }),
        nextCursor: page.nextCursor,
      };
    },

    async sweepPendingAudit() {
      const now = clock.now();
      const expired = await repos.admin.expirePendingAudit(
        now - PENDING_AUDIT_TIMEOUT_MS,
        now,
        SWEEP_BATCH,
      );
      if (expired > 0) log.warn("admin.audit_pending_expired", { entries: expired });
      return expired;
    },

    async enforceRetention() {
      const cutoff = clock.now() - deps.config.admin.auditRetentionDays * DAY_MS;
      const deleted = await repos.admin.deleteAuditBefore(cutoff, RETENTION_BATCH);
      if (deleted > 0) log.info("admin.audit_expired", { entries: deleted });
      return deleted;
    },
  };
}
