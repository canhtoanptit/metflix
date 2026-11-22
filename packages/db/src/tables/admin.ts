/** Tables of the admin area (migration 0007_admin). Representations: see schema.ts. */

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
  audit_log: AuditLogTable;
  job_dead_letters: JobDeadLettersTable;
}

/** Parents first. */
export const ADMIN_TABLES = [
  "audit_log",
  "job_dead_letters",
] as const satisfies readonly (keyof AdminTables)[];
