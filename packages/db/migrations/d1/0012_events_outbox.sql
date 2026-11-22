-- GENERATED from packages/db/src/migrations/events/0012_events_outbox.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create table "event_outbox" ("id" text not null primary key, "account_id" text, "profile_id" text, "payload" text not null, "created_at" integer not null);
create index "event_outbox_created_idx" on "event_outbox" ("created_at", "id");
create index "event_outbox_account_idx" on "event_outbox" ("account_id");
