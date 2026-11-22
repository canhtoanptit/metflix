import type { AuditEntry, JsonValue } from "@webflix/contracts";
import type { IdGenerator } from "../../ports/ids.ts";

/**
 * What a staff route hands the service of the area that owns the data (milestone 2 §8.3): who
 * acts, why, and the request it came with. The admin handlers fill it in from the verified
 * staff identity and the body's `reason`.
 */
export interface StaffAction {
  actor: AuditEntry["actor"];
  reason: string;
  requestId: string | null;
}

/**
 * One `audit_log` row (the contract's `AuditEntry` with an epoch-ms time), written by the owning
 * area's repository in the same batch as the change it records, so a change is never stored
 * without its audit entry or the reverse.
 */
export interface AuditRecord extends Omit<AuditEntry, "createdAt"> {
  createdAt: number;
}

/** The audit row of `action` for a change of `target`, from `before` to `after`. */
export function auditRecord(
  staff: StaffAction,
  change: {
    action: string;
    target: AuditEntry["target"];
    before: JsonValue | null;
    after: JsonValue | null;
  },
  ids: IdGenerator,
  now: number,
): AuditRecord {
  return {
    id: ids.next(),
    actor: { ...staff.actor },
    action: change.action,
    target: { ...change.target },
    before: change.before,
    after: change.after,
    reason: staff.reason,
    requestId: staff.requestId,
    createdAt: now,
  };
}
