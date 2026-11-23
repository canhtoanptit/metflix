-- GENERATED from packages/db/src/migrations/identity/0022_identity_access_proven.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

alter table "accounts" add column "access_proven_at" integer;
