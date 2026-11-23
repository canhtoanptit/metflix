/** Tables of the events area (migrations 0004, 0011, 0012). Representations: see schema.ts. */

export interface ConsentsTable {
  id: string;
  account_id: string;
  purpose: string;
  granted: number;
  source: string;
  created_at: number;
}

export interface PrivacyRequestsTable {
  id: string;
  account_id: string;
  kind: string;
  status: string;
  requested_at: number;
  scheduled_for: number | null;
  completed_at: number | null;
  export_blob_key: string | null;
  expires_at: number | null;
  last_error: string | null;
  updated_at: number;
  /** Deletion: `stopping` | `ending` | `none` (what it did to the membership); null otherwise. */
  membership_step: string | null;
  /** Deletion, `ending`: when the membership ends (the period's close, as billing reported). */
  membership_ends_at: number | null;
  /** Deletion: when its erasure first started (0024). */
  started_at: number | null;
  /** Deletion: erasure attempts so far (0024). */
  attempts: number | null;
  /** Deletion in progress: when the sweep runs its erasure again (also a run's lease) (0024). */
  retry_at: number | null;
  /** `pending` | `sent` | `suppressed`: what the request's email did (0024). */
  email_status: string | null;
}

export interface PrivacyErasuresTable {
  subject_key: string;
  /** `account` | `profile`. */
  kind: string;
  requested_at: number;
  compacted_at: number | null;
  /** Migration 0016: the account erasure a profile record belongs to; null when listed alone. */
  account_key: string | null;
}

export interface AnalyticsDailyTable {
  metric: string;
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  /** A dimension key, `""` for the total. */
  dimension: string;
  value: number;
  updated_at: number;
}

/** Server events waiting for the lake (migration 0012_events_outbox). */
export interface EventOutboxTable {
  id: string;
  account_id: string | null;
  profile_id: string | null;
  /** JSON: the `events.server` job payload. */
  payload: string;
  created_at: number;
}

export interface EventsTables {
  consents: ConsentsTable;
  privacy_requests: PrivacyRequestsTable;
  privacy_erasures: PrivacyErasuresTable;
  analytics_daily: AnalyticsDailyTable;
  event_outbox: EventOutboxTable;
}

/** Parents first. */
export const EVENTS_TABLES = [
  "consents",
  "privacy_requests",
  "privacy_erasures",
  "analytics_daily",
  "event_outbox",
] as const satisfies readonly (keyof EventsTables)[];
