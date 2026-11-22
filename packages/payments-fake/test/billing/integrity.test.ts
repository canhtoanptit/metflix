import { AppError, type MembershipRecord, type ProviderEvent } from "@webflix/core";
import { describe, expect, it } from "vitest";
import { FakePaymentProvider, seededRandom } from "../../src/provider.ts";
import { MemoryFakeStore } from "../../src/store.ts";
import { type BillingHarness, createBillingHarness, DAY_MS } from "./harness.ts";

const DAY_SEC = DAY_MS / 1000;

async function problem(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "expected an AppError").toBeInstanceOf(AppError);
  return (error as AppError).code;
}

/** What the projection says, without bookkeeping (versions, sync times, ids). */
function meaning(record: MembershipRecord | null) {
  if (!record) return null;
  return {
    status: record.status,
    suspendedReason: record.suspendedReason,
    planId: record.planId,
    cancelAtPeriodEnd: record.cancelAtPeriodEnd,
    trialEndsAt: record.trialEndsAt,
    currentPeriodStart: record.currentPeriodStart,
    currentPeriodEnd: record.currentPeriodEnd,
    graceStartedAt: record.graceStartedAt,
    endedAt: record.endedAt,
  };
}

describe("webhooks: the security boundary", () => {
  async function member() {
    const h = await createBillingHarness();
    const auth = await h.account();
    await h.subscribe(auth);
    const record = await h.repos.billing.getMembership(auth.session.accountId);
    const [event] = await h.fake.listEvents({ createdAfter: 0, limit: 1 });
    if (!event || !record) throw new Error("no member");
    return { h, auth, record, event };
  }

  it("refuses a forged, tampered, stale or unsigned delivery before recording anything", async () => {
    const { h, record } = await member();
    const event: ProviderEvent = {
      id: "evt_forged_0001",
      type: "customer.subscription.deleted",
      createdAt: h.clock.now(),
      occurredAt: h.clock.now(),
      customerId: record.providerCustomerId,
      subscriptionId: record.providerSubscriptionId,
      invoiceId: null,
      setupId: null,
      idempotencyKey: null,
    };
    const stranger = new FakePaymentProvider({
      store: new MemoryFakeStore(),
      webhookSecret: "whsec_someone_else_000000000000000000",
      clock: h.clock,
    });
    const forged = await stranger.signedDelivery(event);
    const genuine = await h.fake.signedDelivery(event);
    const tampered = new TextEncoder().encode(
      new TextDecoder()
        .decode(genuine.body)
        .replace("customer.subscription.deleted", "invoice.paid"),
    );
    const stale = await h.fake.signedDelivery(event, { ageSec: 301 });
    const receive = (body: Uint8Array, signature: string | null) =>
      h.services.billing.receiveWebhook("fake", body, signature);

    expect(await problem(receive(forged.body, forged.signature))).toBe("webhook_signature_invalid");
    expect(await problem(receive(tampered, genuine.signature))).toBe("webhook_signature_invalid");
    expect(await problem(receive(stale.body, stale.signature))).toBe("webhook_signature_invalid");
    expect(await problem(receive(genuine.body, null))).toBe("webhook_signature_invalid");
    expect(await problem(receive(genuine.body, "t=1,v1=00"))).toBe("webhook_signature_invalid");
    expect(
      await problem(h.services.billing.receiveWebhook("stripe", genuine.body, genuine.signature)),
    ).toBe("not_found");
    // Nothing reached the event log, the queue or the projection.
    expect(await h.repos.billing.getProviderEvent("fake", event.id)).toBeNull();
    expect(h.queue.size).toBe(0);
    expect(await h.repos.billing.getMembership(record.accountId)).toEqual(record);
    expect(h.logger.records.some((line) => line.msg === "billing.webhook_rejected")).toBe(true);
  });

  it("never applies an event's contents: a genuine 'deleted' event about a live subscription changes nothing", async () => {
    const { h, record } = await member();
    const lie: ProviderEvent = {
      id: "evt_signed_but_stale_0001",
      type: "customer.subscription.deleted",
      createdAt: h.clock.now(),
      occurredAt: h.clock.now(),
      customerId: record.providerCustomerId,
      subscriptionId: record.providerSubscriptionId,
      invoiceId: null,
      setupId: null,
      idempotencyKey: null,
    };
    const delivery = await h.fake.signedDelivery(lie);
    expect(
      await h.services.billing.receiveWebhook("fake", delivery.body, delivery.signature),
    ).toEqual({
      received: true,
      duplicate: false,
    });
    await h.drain();
    // Processing read the subscription again: it is still trialing.
    expect(meaning(await h.repos.billing.getMembership(record.accountId))).toEqual(meaning(record));
  });

  it("never lets an event attribute someone else's subscription to an account", async () => {
    const h = await createBillingHarness();
    const alice = await h.account();
    const bob = await h.account();
    await h.subscribe(alice, { card: "visa" });
    const aliceRecord = await h.repos.billing.getMembership(alice.session.accountId);
    // Bob has a customer but no subscription.
    await h.services.billing.startCheckout(bob, { planId: "basic" });
    const bobCustomer = await h.repos.billing.getCustomer(bob.session.accountId, "fake");
    const crossed: ProviderEvent = {
      id: "evt_crossed_0001",
      type: "customer.subscription.updated",
      createdAt: h.clock.now(),
      occurredAt: h.clock.now(),
      customerId: bobCustomer?.customerId ?? null,
      subscriptionId: aliceRecord?.providerSubscriptionId ?? null,
      invoiceId: null,
      setupId: null,
      idempotencyKey: null,
    };
    const delivery = await h.fake.signedDelivery(crossed);
    await h.services.billing.receiveWebhook("fake", delivery.body, delivery.signature);
    await h.drain();
    expect(await h.repos.billing.getMembership(bob.session.accountId)).toBeNull();
    expect(meaning(await h.repos.billing.getMembership(alice.session.accountId))).toEqual(
      meaning(aliceRecord),
    );
  });

  it("acknowledges a redelivery as a duplicate and processes it once", async () => {
    const { h, event } = await member();
    const delivery = await h.fake.signedDelivery(event);
    const again = await h.services.billing.receiveWebhook(
      "fake",
      delivery.body,
      delivery.signature,
    );
    expect(again).toEqual({ received: true, duplicate: true });
    await h.drain();
    expect((await h.repos.billing.getProviderEvent("fake", event.id))?.status).toBe("processed");
  });
});

describe("idempotency: a retried operation never charges twice", () => {
  it("retries a checkout confirmation that crashed after the provider created the subscription", async () => {
    const h = await createBillingHarness();
    const used = await h.account();
    await h.subscribe(used, { card: "visa" });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    const started = await h.services.billing.startCheckout(auth, { planId: "standard" });
    await h.confirm(started.clientSecret, "visa");

    // The provider answers, then the process dies before it can record the answer.
    const realCreate = h.fake.createSubscription.bind(h.fake);
    let crash = true;
    h.fake.createSubscription = async (input, call) => {
      const created = await realCreate(input, call);
      if (crash) {
        crash = false;
        throw new Error("connection reset after the provider answered");
      }
      return created;
    };
    await expect(h.services.billing.confirmCheckout(accountId, started.id)).rejects.toThrow(
      "connection reset",
    );
    const retried = await h.services.billing.confirmCheckout(accountId, started.id);
    expect(retried.status).toBe("requires_payment");
    const customer = await h.repos.billing.getCustomer(accountId, "fake");
    const invoices = await h.fake.listInvoices({
      customerId: customer?.customerId ?? "",
      limit: 50,
    });
    expect(
      invoices.filter((invoice) => invoice.billingReason === "subscription_create"),
    ).toHaveLength(1);
    // The browser pays the one invoice there is.
    await h.confirm(retried.clientSecret, null);
    await h.drain();
    const paid = await h.fake.listInvoices({ customerId: customer?.customerId ?? "", limit: 50 });
    expect(paid.filter((invoice) => invoice.status === "paid")).toHaveLength(1);
  });

  it("retries a plan change whose answer was lost: one proration invoice, charged once", async () => {
    const h = await createBillingHarness();
    const used = await h.account();
    await h.subscribe(used, { card: "visa" });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { plan: "basic" });
    const preview = await h.services.billing.previewPlanChange(accountId, "premium");
    const realChange = h.fake.changePlan.bind(h.fake);
    let crash = true;
    h.fake.changePlan = async (input, call) => {
      const changed = await realChange(input, call);
      if (crash) {
        crash = false;
        throw new Error("timeout waiting for the provider");
      }
      return changed;
    };
    await expect(
      h.services.billing.changePlan(accountId, {
        planId: "premium",
        previewToken: preview.previewToken,
      }),
    ).rejects.toThrow("timeout");
    // The projection still says basic until the provider is read again (no optimistic write).
    expect((await h.repos.billing.getMembership(accountId))?.planId).toBe("basic");
    const changed = await h.services.billing
      .changePlan(accountId, { planId: "premium", previewToken: preview.previewToken })
      .catch(async (error: unknown) => {
        // The retry may find the plan already changed (the provider applied it): read it.
        if (error instanceof AppError && error.code === "checkout_state_conflict") {
          await h.services.billing.syncAccount(accountId);
          return (await h.services.billing.membership(accountId, null)).legacy;
        }
        throw error;
      });
    expect(changed.plan.id).toBe("premium");
    const customer = await h.repos.billing.getCustomer(accountId, "fake");
    const invoices = await h.fake.listInvoices({
      customerId: customer?.customerId ?? "",
      limit: 50,
    });
    const prorations = invoices.filter(
      (invoice) => invoice.billingReason === "subscription_update",
    );
    expect(prorations).toHaveLength(1);
    expect(prorations[0]?.amountPaidMinor).toBe(preview.amountDue.amountMinor);
  });

  it("gives a declined attempt a new key once the card is fixed (a decline is replayed under its key)", async () => {
    const h = await createBillingHarness();
    const used = await h.account();
    await h.subscribe(used, { card: "visa" });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { plan: "basic", card: "visa", payCard: "visa" });
    // The card on file now declines off-session.
    const setup = await h.services.billing.setupPaymentMethod(accountId);
    await h.confirm(setup.clientSecret, "charge-declined");
    await h.drain();
    const preview = await h.services.billing.previewPlanChange(accountId, "premium");
    expect(
      await problem(
        h.services.billing.changePlan(accountId, {
          planId: "premium",
          previewToken: preview.previewToken,
        }),
      ),
    ).toBe("payment_declined");
    const fix = await h.services.billing.setupPaymentMethod(accountId);
    await h.confirm(fix.clientSecret, "mastercard");
    await h.drain();
    const changed = await h.services.billing.changePlan(accountId, {
      planId: "premium",
      previewToken: preview.previewToken,
    });
    expect(changed.plan.id).toBe("premium");
    const operations = await Promise.all(
      [1, 2].map((attempt) =>
        h.repos.billing.findOperationByKey(
          `webflix-plan-change-${JSON.parse(atob(preview.previewToken.split(".")[0]?.replaceAll("-", "+").replaceAll("_", "/") ?? "")).o}-${attempt}`,
        ),
      ),
    );
    expect(operations.map((operation) => operation?.status)).toEqual(["failed", "succeeded"]);
  });

  it("creates one provider customer per account, however many checkouts race", async () => {
    const h = await createBillingHarness();
    const auth = await h.account();
    await Promise.all([
      h.services.billing.startCheckout(auth, { planId: "basic" }).catch(() => null),
      h.services.billing.startCheckout(auth, { planId: "basic" }).catch(() => null),
    ]);
    const customer = await h.repos.billing.getCustomer(auth.session.accountId, "fake");
    expect(customer).not.toBeNull();
    const created = (await h.fake.listEvents({ createdAfter: 0, limit: 1000 })).filter(
      (event) => event.type === "customer.created",
    );
    expect(created).toHaveLength(1);
  });
});

describe("convergence: any order, duplicates and outages leave the same projection", () => {
  /**
   * A rich life: a trial that converts, a renewal that fails and is retried into grace, a card
   * replaced and the invoice recovered, a plan change, a cancellation at the period end.
   */
  async function life(h: BillingHarness): Promise<string> {
    const auth = await h.account("member@example.test");
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { plan: "standard", card: "charge-declined" });
    await h.services.billing.advanceClock(accountId, 7 * DAY_SEC + 2 * 3600);
    await h.services.billing.advanceClock(accountId, 3 * DAY_SEC + 3600);
    const setup = await h.services.billing.setupPaymentMethod(accountId);
    await h.confirm(setup.clientSecret, "visa");
    await h.drain();
    // The web polls the card change; that read completes it even when no webhook arrives.
    await h.services.billing.getPaymentMethodSetup(accountId, setup.id);
    await h.services.billing.syncAccount(accountId);
    const preview = await h.services.billing.previewPlanChange(accountId, "premium");
    await h.services.billing.changePlan(accountId, {
      planId: "premium",
      previewToken: preview.previewToken,
    });
    await h.services.billing.cancel(accountId);
    await h.services.billing.advanceClock(accountId, 2 * DAY_SEC);
    return accountId;
  }

  async function settle(h: BillingHarness, accountId: string) {
    for (let i = 0; i < 5; i += 1) {
      await h.fake.deliverPending();
      await h.drain();
    }
    return meaning(await h.repos.billing.getMembership(accountId));
  }

  it("orderly, unruly (many seeds) and outage-then-reconcile runs agree", async () => {
    const orderly = await createBillingHarness();
    const expected = await settle(orderly, await life(orderly));
    expect(expected).toMatchObject({
      status: "active",
      planId: "premium",
      cancelAtPeriodEnd: true,
    });

    for (const seed of [1, 2, 3, 4, 5]) {
      const h = await createBillingHarness();
      await h.fake.setDeliveryPolicy({ mode: "unruly", duplicateRate: 0.5, maxDelayMs: 0, seed });
      const accountId = await life(h);
      expect(await settle(h, accountId), `seed ${seed}`).toEqual(expected);
      // Duplicates were delivered and absorbed.
      const duplicates = h.logger.records.filter((line) => line.msg === "billing.transition");
      expect(duplicates.length).toBeGreaterThan(0);
    }

    // An outage for the whole life: nothing is delivered; reconciliation lists the provider's
    // events and repairs the projection.
    const h = await createBillingHarness();
    await h.fake.setDeliveryPolicy({ mode: "outage" });
    const accountId = await life(h);
    await h.fake.setDeliveryPolicy({ mode: "orderly" });
    await h.services.billing.reconcile();
    expect(await settle(h, accountId)).toEqual(expected);
  });

  it("agrees on when grace started for a member left in grace, however the events arrived", async () => {
    async function inGrace(h: BillingHarness): Promise<string> {
      const auth = await h.account("late@example.test");
      const accountId = auth.session.accountId;
      await h.subscribe(auth, { plan: "basic", card: "charge-declined" });
      await h.services.billing.advanceClock(accountId, 7 * DAY_SEC + 2 * 3600);
      await h.services.billing.advanceClock(accountId, 2 * DAY_SEC);
      return accountId;
    }
    const orderly = await createBillingHarness();
    const accountId = await inGrace(orderly);
    const expected = await settle(orderly, accountId);
    const record = await orderly.repos.billing.getMembership(accountId);
    expect(expected?.status).toBe("past_due");
    // Grace starts at the first failed attempt: the trial's end plus the hour before collection.
    expect(expected?.graceStartedAt).toBe((record?.trialEndsAt ?? 0) + 3_600_000);

    for (const seed of [21, 22, 23]) {
      const h = await createBillingHarness();
      await h.fake.setDeliveryPolicy({ mode: "unruly", duplicateRate: 0.5, maxDelayMs: 0, seed });
      const id = await inGrace(h);
      expect(await settle(h, id), `seed ${seed}`).toEqual(expected);
    }
    const outage = await createBillingHarness();
    await outage.fake.setDeliveryPolicy({ mode: "outage" });
    const id = await inGrace(outage);
    await outage.fake.setDeliveryPolicy({ mode: "orderly" });
    await outage.services.billing.reconcile();
    expect(await settle(outage, id)).toEqual(expected);
  });

  it("replays every event of a life twice, in random orders, into a fresh projection: always the same", async () => {
    const store = new MemoryFakeStore();
    const source = await createBillingHarness({ store });
    await source.fake.setDeliveryPolicy({ mode: "outage" });
    const accountId = await life(source);
    const events = await source.fake.listEvents({ createdAfter: 0, limit: 10_000 });
    expect(events.length).toBeGreaterThan(20);
    const customer = await source.repos.billing.getCustomer(accountId, "fake");
    if (!customer) throw new Error("no customer");
    await source.services.billing.reconcile();
    const expected = await settle(source, accountId);
    expect(expected?.status).toBe("active");

    for (const seed of [11, 12, 13, 14, 15, 16]) {
      // A fresh Webflix database in front of the same provider state (the fake's store): only
      // the customer link, Webflix's own record from the checkout, is carried over.
      const replay = await createBillingHarness({ store });
      replay.clock.advance(source.clock.now() - replay.clock.now());
      await replay.repos.accounts.createWithSession({
        account: {
          id: accountId,
          email: "member@example.test",
          passwordHash: "x",
          createdAt: 0,
          updatedAt: 0,
        },
        subscription: {
          accountId,
          planId: "standard",
          startedAt: 0,
          currentPeriodEnd: 0,
          canceledAt: 0,
          card: null,
          updatedAt: 0,
        },
        session: {
          id: `ses-${seed}`,
          tokenHash: `hash-${seed}`,
          accountId,
          activeProfileId: null,
          deviceLabel: "Test",
          deviceType: "desktop",
          persistent: true,
          createdAt: 0,
          lastSeenAt: 0,
          expiresAt: 1,
        },
      });
      await replay.repos.billing.saveCustomer(customer);
      const random = seededRandom(seed);
      const deliveries = [...events, ...events]
        .map((event) => ({ event, key: random() }))
        .sort((a, b) => a.key - b.key)
        .map(({ event }) => event);
      for (const event of deliveries) {
        const delivery = await source.fake.signedDelivery(event);
        await replay.services.billing.receiveWebhook("fake", delivery.body, delivery.signature);
      }
      await replay.drain();
      expect(meaning(await replay.repos.billing.getMembership(accountId)), `seed ${seed}`).toEqual(
        expected,
      );
    }
  });
});
