import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Billing area: what the projection, the webhook pipeline and the two-step checkout need beyond
 * 0003 (docs/BLUEPRINT-M2.md §5.2-§5.4). Columns only, nullable or with a default.
 *
 * - `memberships.grace_invoice_id`: the open invoice whose first failed attempt started grace,
 *   so a late failure event of an older invoice never restarts it.
 * - `memberships.clock_offset_ms`: the provider's time minus ours for this customer (a test
 *   clock; 0 or null in real time), so grace and period ends are judged in the provider's time.
 * - Every added column is nullable: SQLite and D1 cannot add a NOT NULL column without a
 *   rebuild of a table others reference (FOUNDATION.md §8.4, D-M2-5); null attempts read as 1.
 * - `provider_events.*`: the normalised ids of a verified event (never its object), so a
 *   recorded event can be processed, replayed or dead-lettered from the table alone.
 * - `checkouts.*`: the promotion (its id at the provider and what it does, as validated) and
 *   the card the checkout uses, the trial fingerprint it claimed (released if the subscription
 *   cannot be created) and its attempt number (idempotency keys).
 * - `payment_method_setups.*`: the confirmed card, and the operation attempt of a card change.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);

  await db.schema.alterTable("memberships").addColumn("grace_invoice_id", t.text).execute();
  // Added columns stay nullable (no table rebuild on SQLite/D1): null reads as 0.
  await db.schema.alterTable("memberships").addColumn("clock_offset_ms", t.time).execute();

  for (const column of [
    "provider_customer_id",
    "provider_subscription_id",
    "provider_invoice_id",
    "provider_setup_id",
    "source",
  ]) {
    await db.schema.alterTable("provider_events").addColumn(column, t.text).execute();
  }
  await db.schema.alterTable("provider_events").addColumn("event_created_at", t.time).execute();

  for (const column of [
    "promotion_id",
    "promotion_json",
    "provider_payment_method_id",
    "trial_fingerprint",
  ]) {
    await db.schema.alterTable("checkouts").addColumn(column, t.text).execute();
  }
  await db.schema.alterTable("checkouts").addColumn("attempt", t.int).execute();

  await db.schema
    .alterTable("payment_method_setups")
    .addColumn("provider_payment_method_id", t.text)
    .execute();
  await db.schema.alterTable("payment_method_setups").addColumn("attempt", t.int).execute();

  await db.schema
    .createIndex("provider_events_subscription_idx")
    .on("provider_events")
    .columns(["provider", "provider_subscription_id"])
    .execute();
  await db.schema
    .createIndex("checkouts_subscription_idx")
    .on("checkouts")
    .column("provider_subscription_id")
    .execute();
}
