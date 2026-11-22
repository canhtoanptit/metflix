-- GENERATED from packages/db/src/migrations/events/0020_events_deletion_membership.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

alter table "privacy_requests" add column "membership_step" text;
alter table "privacy_requests" add column "membership_ends_at" integer;
create index "privacy_requests_membership_step_idx" on "privacy_requests" ("membership_step", "updated_at");
