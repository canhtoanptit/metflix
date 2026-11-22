-- GENERATED from packages/db/src/migrations/personalisation/0009_personalisation_lists.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create table "recommendation_profile_lists" ("model_version" text not null, "profile_key" text not null, "payload" text not null, "expires_at" integer not null, constraint "recommendation_profile_lists_pkey" primary key ("model_version", "profile_key"));
alter table "recommendation_models" add column "finished_at" integer;
