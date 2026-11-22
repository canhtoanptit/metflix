-- GENERATED from packages/db/src/migrations/events/0016_events_erasure_scope.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

alter table "privacy_erasures" add column "account_key" text;
create index "privacy_erasures_account_key_idx" on "privacy_erasures" ("account_key");
