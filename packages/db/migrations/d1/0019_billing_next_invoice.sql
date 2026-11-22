-- GENERATED from packages/db/src/migrations/billing/0019_billing_next_invoice.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

alter table "memberships" add column "next_invoice_json" text;
