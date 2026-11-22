import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Milestone 2, billing area (docs/BLUEPRINT-M2.md §5, docs/STRIPE.md): the membership
 * projection, provider events, money-moving operations, trials, invoices, refunds, the
 * catalogue, checkouts, and the fake provider's own state.
 *
 * Billing records (customers, operations, events, invoices, refunds, trial fingerprints) carry
 * `account_id` without a foreign key on purpose: deleting an account (§6.3) must not delete what
 * the law requires to be retained. The projection, checkouts and setups do cascade.
 * Milestone 1's `subscriptions` (the mock) stays until billing replaces it.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);

  await db.schema
    .createTable("billing_customers")
    .addColumn("account_id", t.text, (c) => c.notNull())
    .addColumn("provider", t.text, (c) => c.notNull())
    .addColumn("customer_id", t.text, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("billing_customers_pkey", ["account_id", "provider"])
    .addUniqueConstraint("billing_customers_provider_customer_key", ["provider", "customer_id"])
    .execute();

  // §5.2: one row per account, written only from verified provider state, with a version guard.
  await db.schema
    .createTable("memberships")
    .addColumn("account_id", t.text, (c) =>
      c.primaryKey().notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("provider", t.text, (c) => c.notNull())
    .addColumn("provider_customer_id", t.text, (c) => c.notNull())
    .addColumn("provider_subscription_id", t.text)
    .addColumn("plan_id", t.text)
    .addColumn("price_lookup_key", t.text)
    .addColumn("status", t.text, (c) => c.notNull())
    .addColumn("suspended_reason", t.text)
    .addColumn("cancel_at_period_end", t.bool, (c) => c.notNull())
    .addColumn("trial_ends_at", t.time)
    .addColumn("current_period_start", t.time)
    .addColumn("current_period_end", t.time)
    // §5.2: the first failed renewal attempt; the provider has no such field.
    .addColumn("grace_started_at", t.time)
    .addColumn("ended_at", t.time)
    .addColumn("latest_invoice_id", t.text)
    // Display only (brand, last four, expiry), as the provider reports it.
    .addColumn("payment_method_json", t.text)
    // One trial per account (§5.4), kept across subscriptions.
    .addColumn("trial_redeemed_at", t.time)
    .addColumn("version", t.int, (c) => c.notNull())
    .addColumn("provider_synced_at", t.time, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("memberships_subscription_idx")
    .on("memberships")
    .columns(["provider", "provider_subscription_id"])
    .execute();
  await db.schema
    .createIndex("memberships_status_idx")
    .on("memberships")
    .columns(["status", "current_period_end"])
    .execute();

  // §5.3: every money-moving request, safe to retry; the key is (operation, attempt).
  await db.schema
    .createTable("billing_operations")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("account_id", t.text, (c) => c.notNull())
    .addColumn("kind", t.text, (c) => c.notNull())
    .addColumn("attempt", t.int, (c) => c.notNull())
    .addColumn("idempotency_key", t.text, (c) => c.notNull())
    .addColumn("status", t.text, (c) => c.notNull())
    .addColumn("provider", t.text, (c) => c.notNull())
    .addColumn("provider_ref", t.text)
    .addColumn("error_code", t.text)
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .addUniqueConstraint("billing_operations_idempotency_key_key", ["idempotency_key"])
    .execute();
  await db.schema
    .createIndex("billing_operations_account_idx")
    .on("billing_operations")
    .columns(["account_id", "created_at"])
    .execute();

  // §5.3: recorded before the 2xx; processing is a job, idempotent by event id.
  await db.schema
    .createTable("provider_events")
    .addColumn("provider", t.text, (c) => c.notNull())
    .addColumn("event_id", t.text, (c) => c.notNull())
    .addColumn("type", t.text, (c) => c.notNull())
    .addColumn("account_id", t.text)
    .addColumn("idempotency_key", t.text)
    .addColumn("received_at", t.time, (c) => c.notNull())
    .addColumn("processed_at", t.time)
    .addColumn("status", t.text, (c) => c.notNull())
    .addColumn("attempts", t.int, (c) => c.notNull())
    .addColumn("last_error", t.text)
    .addPrimaryKeyConstraint("provider_events_pkey", ["provider", "event_id"])
    .execute();
  await db.schema
    .createIndex("provider_events_status_idx")
    .on("provider_events")
    .columns(["status", "received_at"])
    .execute();

  // §5.4: one trial per card fingerprint (Stripe enforces none).
  await db.schema
    .createTable("trial_fingerprints")
    .addColumn("provider", t.text, (c) => c.notNull())
    .addColumn("fingerprint", t.text, (c) => c.notNull())
    .addColumn("account_id", t.text, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("trial_fingerprints_pkey", ["provider", "fingerprint"])
    .execute();
  await db.schema
    .createIndex("trial_fingerprints_account_idx")
    .on("trial_fingerprints")
    .column("account_id")
    .execute();

  await db.schema
    .createTable("invoices")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("account_id", t.text, (c) => c.notNull())
    .addColumn("provider", t.text, (c) => c.notNull())
    .addColumn("provider_invoice_id", t.text, (c) => c.notNull())
    .addColumn("provider_subscription_id", t.text)
    .addColumn("number", t.text)
    .addColumn("status", t.text, (c) => c.notNull())
    .addColumn("currency", t.text, (c) => c.notNull())
    .addColumn("total_minor", t.int, (c) => c.notNull())
    .addColumn("amount_paid_minor", t.int, (c) => c.notNull())
    .addColumn("amount_due_minor", t.int, (c) => c.notNull())
    .addColumn("amount_refunded_minor", t.int, (c) => c.notNull())
    .addColumn("billing_reason", t.text, (c) => c.notNull())
    .addColumn("period_start", t.time)
    .addColumn("period_end", t.time)
    .addColumn("hosted_url", t.text)
    .addColumn("pdf_url", t.text)
    .addColumn("issued_at", t.time, (c) => c.notNull())
    .addColumn("paid_at", t.time)
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .addUniqueConstraint("invoices_provider_invoice_key", ["provider", "provider_invoice_id"])
    .execute();
  await db.schema
    .createIndex("invoices_account_idx")
    .on("invoices")
    .columns(["account_id", "issued_at"])
    .execute();

  await db.schema
    .createTable("refunds")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("account_id", t.text, (c) => c.notNull())
    .addColumn("invoice_id", t.text, (c) => c.notNull())
    .addColumn("provider", t.text, (c) => c.notNull())
    .addColumn("provider_refund_id", t.text)
    .addColumn("amount_minor", t.int, (c) => c.notNull())
    .addColumn("currency", t.text, (c) => c.notNull())
    .addColumn("status", t.text, (c) => c.notNull())
    .addColumn("reason", t.text)
    .addColumn("staff_subject", t.text)
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema.createIndex("refunds_invoice_idx").on("refunds").column("invoice_id").execute();

  // §5.4: prices per plan and currency live in Webflix and sync to the provider by lookup key.
  await db.schema
    .createTable("plan_prices")
    .addColumn("plan_id", t.text, (c) => c.notNull())
    .addColumn("currency", t.text, (c) => c.notNull())
    .addColumn("amount_minor", t.int, (c) => c.notNull())
    .addColumn("lookup_key", t.text, (c) => c.notNull())
    .addColumn("active", t.bool, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("plan_prices_pkey", ["plan_id", "currency"])
    .addUniqueConstraint("plan_prices_lookup_key_key", ["lookup_key"])
    .execute();
  await db.schema
    .createTable("provider_prices")
    .addColumn("provider", t.text, (c) => c.notNull())
    .addColumn("lookup_key", t.text, (c) => c.notNull())
    .addColumn("provider_price_id", t.text, (c) => c.notNull())
    .addColumn("amount_minor", t.int, (c) => c.notNull())
    .addColumn("synced_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("provider_prices_pkey", ["provider", "lookup_key"])
    .execute();

  // §5.1, §5.4: the two-step checkout (`Checkout` in the contract).
  await db.schema
    .createTable("checkouts")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("account_id", t.text, (c) =>
      c.notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("plan_id", t.text, (c) => c.notNull())
    .addColumn("currency", t.text, (c) => c.notNull())
    .addColumn("status", t.text, (c) => c.notNull())
    .addColumn("promotion_code", t.text)
    .addColumn("provider", t.text, (c) => c.notNull())
    .addColumn("provider_customer_id", t.text)
    .addColumn("provider_setup_id", t.text)
    .addColumn("provider_subscription_id", t.text)
    .addColumn("trial_days", t.int)
    .addColumn("amount_due_minor", t.int)
    .addColumn("failure_reason", t.text)
    .addColumn("operation_id", t.text)
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("expires_at", t.time, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("checkouts_account_idx")
    .on("checkouts")
    .columns(["account_id", "created_at"])
    .execute();

  await db.schema
    .createTable("payment_method_setups")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("account_id", t.text, (c) =>
      c.notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("provider", t.text, (c) => c.notNull())
    .addColumn("provider_setup_id", t.text, (c) => c.notNull())
    .addColumn("status", t.text, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("payment_method_setups_account_idx")
    .on("payment_method_setups")
    .column("account_id")
    .execute();

  // §5.5: the fake provider keeps its state in the database (every dialect, survives restarts):
  // its objects as versioned JSON documents, its idempotency records and per-customer clocks.
  await db.schema
    .createTable("payments_fake_objects")
    .addColumn("kind", t.text, (c) => c.notNull())
    .addColumn("id", t.text, (c) => c.notNull())
    .addColumn("customer_id", t.text)
    .addColumn("data_json", t.text, (c) => c.notNull())
    .addColumn("version", t.int, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("payments_fake_objects_pkey", ["kind", "id"])
    .execute();
  await db.schema
    .createIndex("payments_fake_objects_customer_idx")
    .on("payments_fake_objects")
    .column("customer_id")
    .execute();
  await db.schema
    .createTable("payments_fake_idempotency")
    .addColumn("idempotency_key", t.text, (c) => c.primaryKey().notNull())
    .addColumn("fingerprint", t.text, (c) => c.notNull())
    .addColumn("outcome_json", t.text, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("payments_fake_clocks")
    .addColumn("customer_id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("now_ms", t.time, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .execute();
}
