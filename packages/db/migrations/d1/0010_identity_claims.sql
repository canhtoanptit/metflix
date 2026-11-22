-- GENERATED from packages/db/src/migrations/identity/0010_identity_claims.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create table "identity_claims" ("claim_key" text not null primary key, "expires_at" integer not null);
create index "identity_claims_expires_idx" on "identity_claims" ("expires_at");
