/** Tables of the admin area (migrations 0007_admin, 0014_admin_audit_outcome). Representations: see schema.ts. */
import type { Generated } from "kysely";

/**
 * The `audit_log` columns every area's repository writes (experiments and personalisation write
 * their row in the same batch as their change; see `auditLogRow`).
 */
export interface AuditLogTable {
  id: string;
  /** `staff` | `member` | `system`. */
  actor_type: string;
  actor_id: string;
  actor_name: string | null;
  action: string;
  target_type: string;
  target_id: string;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  request_id: string | null;
  created_at: number;
}

/**
 * The columns only the admin area writes (0014): the outcome of an action the staff API audits
 * ahead of the call (`pending` until settled), and the console's idempotency key. A row written
 * in the same batch as its change takes the defaults (`succeeded`, nulls).
 */
export interface AuditOutcomeColumns {
  /**
   * `pending` | `succeeded` | `failed` | `unknown` (AUDIT_OUTCOMES). Default `succeeded`; nullable
   * only because an added column must be (read as `succeeded`).
   */
  outcome: Generated<string | null>;
  completed_at: number | null;
  /** Unique when set. */
  idempotency_key: string | null;
}

export interface JobDeadLettersTable {
  id: string;
  job_type: string;
  payload_json: string;
  attempts: number;
  last_error: string | null;
  failed_at: number;
  replayed_at: number | null;
}

export interface AdminTables {
  audit_log: AuditLogTable & AuditOutcomeColumns;
  job_dead_letters: JobDeadLettersTable;
}

/** Parents first. */
export const ADMIN_TABLES = [
  "audit_log",
  "job_dead_letters",
] as const satisfies readonly (keyof AdminTables)[];
