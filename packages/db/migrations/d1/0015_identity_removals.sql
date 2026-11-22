-- GENERATED from packages/db/src/migrations/identity/0015_identity_removals.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create table "identity_removals" ("provider" text not null, "subject" text not null, "account_id" text not null references "accounts" ("id") on delete cascade, "reason" text not null, "removed_at" integer not null, constraint "identity_removals_pkey" primary key ("provider", "subject"));
create index "identity_removals_account_idx" on "identity_removals" ("account_id");
