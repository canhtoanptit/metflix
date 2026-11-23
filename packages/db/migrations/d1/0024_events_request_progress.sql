-- GENERATED from packages/db/src/migrations/events/0024_events_request_progress.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

alter table "privacy_requests" add column "started_at" integer;
alter table "privacy_requests" add column "attempts" integer;
alter table "privacy_requests" add column "retry_at" integer;
alter table "privacy_requests" add column "email_status" text;
create index "privacy_requests_retry_idx" on "privacy_requests" ("status", "retry_at");
