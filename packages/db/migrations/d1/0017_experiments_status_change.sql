-- GENERATED from packages/db/src/migrations/experiments/0017_experiments_status_change.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

alter table "experiments" add column "previous_status" text;
alter table "experiments" add column "status_change_at" integer;
