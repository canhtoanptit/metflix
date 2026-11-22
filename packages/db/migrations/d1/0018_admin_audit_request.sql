-- GENERATED from packages/db/src/migrations/admin/0018_admin_audit_request.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create index "audit_log_request_idx" on "audit_log" ("request_id", "created_at");
