import type { Database } from "@webflix/db";
import { createRepositories, migrateToLatest } from "@webflix/db";
import { createSqliteDatabase } from "@webflix/db/sqlite";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createSqlFakeStore } from "../../src/sql-store.ts";
import { createBillingHarness } from "../billing/harness.ts";

/**
 * Erasing a paying member on a real database (foreign keys on), fake provider state in the same
 * database as the conformance variant keeps it (privacy review M5). Afterwards a scan of every
 * table for the account id, the email, the provider customer id and the card label finds only
 * the financial record (invoices and refunds, and the provider's own invoices, refunds and the
 * subscriptions they were for, under a customer stub that names no one) and the trial
 * fingerprint, which no longer leads to the account. Whatever the provider says about that
 * customer afterwards is acknowledged and not stored.
 */

/** Every row of every table holding one of `needles`: `table: needle` (with the fake's kind). */
async function scan(database: Database, needles: Record<string, string>): Promise<string[]> {
  const tables = await sql<{ name: string }>`
    select name from sqlite_master where type = 'table' and name not like 'sqlite_%'
  `.execute(database.db);
  const hits = new Set<string>();
  for (const { name } of tables.rows) {
    const rows = await sql<Record<string, unknown>>`select * from ${sql.table(name)}`.execute(
      database.db,
    );
    for (const row of rows.rows) {
      const text = JSON.stringify(row);
      for (const [label, needle] of Object.entries(needles)) {
        if (!text.includes(needle)) continue;
        hits.add(
          name === "payments_fake_objects" ? `${name}(${row.kind}): ${label}` : `${name}: ${label}`,
        );
      }
    }
  }
  return [...hits].sort();
}

describe("what billing keeps of an erased account (SQLite, the fake provider's tables beside)", () => {
  it("only the financial record and an unlinked trial fingerprint; later events are not stored", async () => {
    const database = createSqliteDatabase({ path: ":memory:" });
    await migrateToLatest(database);
    const repos = createRepositories(database);
    const h = await createBillingHarness({ repos, store: createSqlFakeStore(database) });
    try {
      const label = `m5label${Date.now().toString(36)}`;
      const auth = await h.account();
      const accountId = auth.session.accountId;
      const email = (await repos.identity.getAccount(accountId))?.email ?? "";
      // A trial on a labelled card, converted and paid; then a card change: every kind of record.
      await h.subscribe(auth, { plan: "basic", card: `visa:${label}` });
      await h.services.billing.advanceClock(accountId, 8 * 24 * 3600);
      await h.drain();
      const setup = await h.services.billing.setupPaymentMethod(accountId);
      await h.confirm(setup.clientSecret, `mastercard:${label}x`);
      await h.services.billing.getPaymentMethodSetup(accountId, setup.id);
      await h.drain();
      const customer = await repos.billing.getCustomer(accountId, "fake");
      const membership = await repos.billing.getMembership(accountId);
      if (!customer || !membership?.providerSubscriptionId) throw new Error("no member");
      const needles = { account: accountId, email, customer: customer.customerId, card: label };
      const before = await scan(database, needles);
      expect(before).toEqual(
        expect.arrayContaining([
          "billing_customers: account",
          "billing_operations: account",
          "provider_events: account",
          "trial_fingerprints: account",
          "payments_fake_idempotency: email",
        ]),
      );

      // The events area's erasure: billing's part first (twice: the job may run again), then
      // the account row goes.
      await h.services.billing.eraseAccountData?.(accountId);
      await h.services.billing.eraseAccountData?.(accountId);
      expect(await repos.events.deleteAccount(accountId)).toBe(true);
      await h.drain();

      // The provider tells Webflix about that customer again (a late redelivery).
      const late = {
        id: "evt_fake_after_erasure",
        type: "customer.subscription.deleted",
        createdAt: h.clock.now(),
        occurredAt: h.clock.now(),
        customerId: customer.customerId,
        subscriptionId: membership.providerSubscriptionId,
        invoiceId: null,
        setupId: null,
        idempotencyKey: null,
      };
      const delivery = await h.fake.signedDelivery(late);
      expect(
        await h.services.billing.receiveWebhook("fake", delivery.body, delivery.signature),
      ).toEqual({ received: true, duplicate: false });
      h.clock.advance(15 * 60_000);
      await h.services.billing.reconcile();
      await h.drain();
      expect(h.queue.deadLetters).toHaveLength(0);
      expect(await repos.billing.getProviderEvent("fake", late.id)).toBeNull();

      const after = await scan(database, needles);
      expect(after).toEqual([
        // Webflix's invoices (and refunds, none here) keep the account they were issued to.
        "invoices: account",
        // The provider's financial record: its invoices and the subscription they were for,
        // under a stub of the deleted customer (and that customer's version counter).
        "payments_fake_objects(customer): customer",
        "payments_fake_objects(guard): customer",
        "payments_fake_objects(invoice): customer",
        "payments_fake_objects(subscription): customer",
      ]);
      // The trial's card fingerprint is still known (one trial per card), owned by no one.
      const fingerprints = await sql<{
        fingerprint: string;
        account_id: string;
        created_at: number;
      }>`
        select fingerprint, account_id, created_at from trial_fingerprints
      `.execute(database.db);
      expect(fingerprints.rows).toHaveLength(1);
      expect(fingerprints.rows[0]).toMatchObject({ account_id: "erased", created_at: 0 });
      expect(fingerprints.rows[0]?.fingerprint.startsWith("account:")).toBe(false);
      // Invoices keep the amounts, not the provider's hosted pages (they show name and address).
      const invoices = await repos.billing.listInvoices(accountId, { limit: 10, before: null });
      expect(invoices.length).toBeGreaterThan(0);
      expect(
        invoices.every((invoice) => invoice.hostedUrl === null && invoice.pdfUrl === null),
      ).toBe(true);
      expect(h.logger.records.some((line) => line.msg === "billing.event_not_ours")).toBe(true);
    } finally {
      await database.close();
    }
  });
});
