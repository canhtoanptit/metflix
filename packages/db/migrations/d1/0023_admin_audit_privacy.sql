-- GENERATED from packages/db/src/migrations/admin/0023_admin_audit_privacy.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

update "audit_log" set "target_id" = substr("target_id", 1, 1) || '***' where "action" = 'member.searched' and "target_id" not like '%***';
update "audit_log" set "before_json" = null where "action" = 'privacy.erasures_confirmed';
