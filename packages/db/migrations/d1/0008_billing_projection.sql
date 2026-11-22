-- GENERATED from packages/db/src/migrations/billing/0008_billing_projection.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

alter table "memberships" add column "grace_invoice_id" text;
alter table "memberships" add column "clock_offset_ms" integer;
alter table "provider_events" add column "provider_customer_id" text;
alter table "provider_events" add column "provider_subscription_id" text;
alter table "provider_events" add column "provider_invoice_id" text;
alter table "provider_events" add column "provider_setup_id" text;
alter table "provider_events" add column "source" text;
alter table "provider_events" add column "event_created_at" integer;
alter table "checkouts" add column "promotion_id" text;
alter table "checkouts" add column "promotion_json" text;
alter table "checkouts" add column "provider_payment_method_id" text;
alter table "checkouts" add column "trial_fingerprint" text;
alter table "checkouts" add column "attempt" integer;
alter table "payment_method_setups" add column "provider_payment_method_id" text;
alter table "payment_method_setups" add column "attempt" integer;
create index "provider_events_subscription_idx" on "provider_events" ("provider", "provider_subscription_id");
create index "checkouts_subscription_idx" on "checkouts" ("provider_subscription_id");
