-- GENERATED from packages/db/src/migrations/events/0004_events.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create table "consents" ("id" text not null primary key, "account_id" text not null references "accounts" ("id") on delete cascade, "purpose" text not null, "granted" integer not null, "source" text not null, "created_at" integer not null);
create index "consents_account_idx" on "consents" ("account_id", "purpose", "created_at");
create table "privacy_requests" ("id" text not null primary key, "account_id" text not null, "kind" text not null, "status" text not null, "requested_at" integer not null, "scheduled_for" integer, "completed_at" integer, "export_blob_key" text, "expires_at" integer, "last_error" text, "updated_at" integer not null);
create index "privacy_requests_account_idx" on "privacy_requests" ("account_id", "kind", "requested_at");
create index "privacy_requests_due_idx" on "privacy_requests" ("status", "scheduled_for");
create table "privacy_erasures" ("subject_key" text not null primary key, "kind" text not null, "requested_at" integer not null, "compacted_at" integer);
create table "analytics_daily" ("metric" text not null, "day" text not null, "dimension" text not null, "value" real not null, "updated_at" integer not null, constraint "analytics_daily_pkey" primary key ("metric", "day", "dimension"));
