import { createRepositories, migrateToLatest } from "@webflix/db";
import { createSqliteDatabase } from "@webflix/db/sqlite";
import { describe, expect, it } from "vitest";
import { createSqlFakeStore } from "../../src/sql-store.ts";
import { createBillingHarness } from "../billing/harness.ts";

/**
 * Erasing a paying member on a real database (foreign keys on): the provider cancels the
 * subscription and keeps sending events about it; each is recorded and processed once, as a
 * skip, and no reconciliation tick brings it back.
 */
describe("provider events about an erased account (SQLite, foreign keys enforced)", () => {
  it("are processed once as skipped; reconciliation re-queues nothing; billing records stay", async () => {
    const database = createSqliteDatabase({ path: ":memory:" });
    await migrateToLatest(database);
    const repos = createRepositories(database);
    const h = await createBillingHarness({ repos, store: createSqlFakeStore(database) });
    try {
      const used = await h.account();
      await h.subscribe(used, { card: "visa" });
      const auth = await h.account();
      const accountId = auth.session.accountId;
      await h.subscribe(auth, { plan: "basic", card: "visa" });
      expect((await repos.billing.getMembership(accountId))?.status).toBe("active");

      // The events area's erasure: billing's part first, then the account row goes.
      await h.services.billing.eraseAccountData?.(accountId);
      expect(await repos.events.deleteAccount(accountId)).toBe(true);
      await h.drain();
      // Whatever the provider says next about that customer (here: it is told again).
      const customer = await repos.billing.getCustomer(accountId, "fake");
      const later = (await h.fake.listEvents({ createdAfter: 0, limit: 10_000 })).filter(
        (event) => event.customerId === customer?.customerId,
      );
      expect(later.some((event) => event.type === "customer.subscription.deleted")).toBe(true);
      for (const event of later) {
        const delivery = await h.fake.signedDelivery(event);
        await h.services.billing.receiveWebhook("fake", delivery.body, delivery.signature);
      }
      await h.drain();
      expect(h.queue.deadLetters).toHaveLength(0);
      for (const event of later) {
        const recorded = await repos.billing.getProviderEvent("fake", event.id);
        expect(recorded?.status, event.type).toBe("processed");
        expect(recorded?.attempts, event.type).toBe(1);
      }
      // A reconciliation tick afterwards: nothing pending, nothing re-queued, nothing failing.
      h.clock.advance(15 * 60_000);
      const tick = await h.services.billing.reconcile();
      expect(tick.requeued).toBe(0);
      await h.drain();
      expect(h.queue.deadLetters).toHaveLength(0);
      expect(h.queue.size).toBe(0);
      expect(await repos.billing.getMembership(accountId)).toBeNull();
      // Billing records are kept (no foreign key to the account, D-M2-6).
      expect(
        (await repos.billing.listInvoices(accountId, { limit: 10, before: null })).length,
      ).toBeGreaterThan(0);
      expect(h.logger.records.some((line) => line.msg === "billing.account_gone")).toBe(true);
    } finally {
      await database.close();
    }
  });
});
