-- GENERATED from packages/db/src/migrations/admin/0007_admin.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create table "audit_log" ("id" text not null primary key, "actor_type" text not null, "actor_id" text not null, "actor_name" text, "action" text not null, "target_type" text not null, "target_id" text not null, "before_json" text, "after_json" text, "reason" text, "request_id" text, "created_at" integer not null);
create index "audit_log_created_idx" on "audit_log" ("created_at");
create index "audit_log_target_idx" on "audit_log" ("target_type", "target_id", "created_at");
create index "audit_log_actor_idx" on "audit_log" ("actor_id", "created_at");
create table "job_dead_letters" ("id" text not null primary key, "job_type" text not null, "payload_json" text not null, "attempts" integer not null, "last_error" text, "failed_at" integer not null, "replayed_at" integer);
create index "job_dead_letters_failed_idx" on "job_dead_letters" ("failed_at");
