-- GENERATED from packages/db/src/migrations/billing/0026_billing_amount_reasons.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

alter table "invoices" add column "credit_applied_minor" integer;
alter table "invoices" add column "discount_minor" integer;
alter table "checkouts" add column "credit_applied_minor" integer;
alter table "checkouts" add column "discount_minor" integer;
