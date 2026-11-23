-- GENERATED from packages/db/src/migrations/personalisation/0025_personalisation_withdrawals.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create table "recommendation_withdrawals" ("subject_key" text not null primary key, "account_key" text not null, "kind" text not null, "withdrawn_at" integer not null);
create index "recommendation_withdrawals_account" on "recommendation_withdrawals" ("account_key");
