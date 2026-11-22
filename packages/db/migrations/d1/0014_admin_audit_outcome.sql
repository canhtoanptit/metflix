-- GENERATED from packages/db/src/migrations/admin/0014_admin_audit_outcome.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

alter table "audit_log" add column "outcome" text default 'succeeded';
alter table "audit_log" add column "completed_at" integer;
alter table "audit_log" add column "idempotency_key" text;
create unique index "audit_log_idempotency_key_idx" on "audit_log" ("idempotency_key");
create index "audit_log_outcome_idx" on "audit_log" ("outcome", "created_at");
