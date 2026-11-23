-- GENERATED from packages/db/src/migrations/billing/0021_billing_client_secrets.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

alter table "checkouts" add column "client_secret" text;
alter table "payment_method_setups" add column "client_secret" text;
alter table "payment_method_setups" add column "failure_reason" text;
