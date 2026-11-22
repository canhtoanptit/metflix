import {
  billingIdempotencyKey,
  type PaymentFailureCode,
  PaymentProviderError,
  type ProviderEvent,
} from "@webflix/core";
import { describe, expect, it } from "vitest";
import type { FakeTestCard } from "../src/cards.ts";
import { FakePaymentProvider, type FakePaymentProviderOptions } from "../src/provider.ts";
import { MemoryFakeStore } from "../src/store.ts";
import { TEST_PRICES, TEST_WEBHOOK_SECRET } from "./harness.ts";

const DAY_SEC = 24 * 60 * 60;
const key = () => ({ idempotencyKey: billingIdempotencyKey(crypto.randomUUID(), 1) });

async function setup(options: Partial<FakePaymentProviderOptions> = {}) {
  const fake = new FakePaymentProvider({
    store: new MemoryFakeStore(),
    webhookSecret: TEST_WEBHOOK_SECRET,
    ...options,
  });
  await fake.syncCatalogue([TEST_PRICES.basic, TEST_PRICES.premium]);
  const delivered: ProviderEvent[] = [];
  fake.attachWebhookReceiver(async ({ body, signature }) => {
    delivered.push(await fake.parseWebhook(body, signature));
  });

  async function member(card: FakeTestCard = "visa") {
    const customer = await fake.createCustomer(
      { accountId: crypto.randomUUID(), email: "member@example.test" },
      key(),
    );
    const created = await fake.createSetup({ customerId: customer.id }, key());
    await fake.confirmSetup(created.clientSecret ?? "", card, { challenge: "complete" });
    const confirmed = await fake.retrieveSetup(created.id);
    return { customerId: customer.id, paymentMethodId: confirmed?.paymentMethod?.id ?? null };
  }

  async function trialing(card: FakeTestCard = "visa") {
    const { customerId, paymentMethodId } = await member(card);
    const subscription = await fake.createSubscription(
      {
        customerId,
        priceLookupKey: TEST_PRICES.basic.lookupKey,
        paymentMethodId,
        trialDays: 7,
        promotionId: null,
      },
      key(),
    );
    return { customerId, subscription };
  }

  return { fake, delivered, member, trialing };
}

async function failure(promise: Promise<unknown>): Promise<PaymentFailureCode> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PaymentProviderError);
  return (error as PaymentProviderError).code;
}

describe("fake provider: the test clock", () => {
  it("converts a trial at its end and collects the renewal an hour later", async () => {
    const { fake, trialing } = await setup();
    const { customerId, subscription } = await trialing();
    expect(subscription.status).toBe("trialing");
    await fake.advanceClock(customerId, 7 * DAY_SEC + 60);
    const converted = await fake.retrieveSubscription(subscription.id);
    expect(converted?.status).toBe("active");
    const renewal = await fake.retrieveInvoice(converted?.latestInvoiceId ?? "");
    expect(renewal).toMatchObject({ status: "open", billingReason: "subscription_cycle" });
    await fake.advanceClock(customerId, 3600);
    expect(await fake.retrieveInvoice(renewal?.id ?? "")).toMatchObject({
      status: "paid",
      amountPaidMinor: TEST_PRICES.basic.amountMinor,
    });
    expect((await fake.retrieveSubscription(subscription.id))?.clockNow).toBeGreaterThan(
      Date.now() + 7 * DAY_SEC * 1000,
    );
  });

  it("keeps each customer's clock to itself", async () => {
    const { fake, trialing } = await setup();
    const first = await trialing();
    const second = await trialing();
    await fake.advanceClock(first.customerId, 8 * DAY_SEC);
    expect((await fake.retrieveSubscription(first.subscription.id))?.status).toBe("active");
    expect((await fake.retrieveSubscription(second.subscription.id))?.status).toBe("trialing");
    expect(await fake.clockNow(second.customerId)).toBeLessThan(Date.now() + 60_000);
  });

  it("retries a declined renewal, goes past due, and cancels when retries run out", async () => {
    const { fake, trialing, delivered } = await setup({ retryDays: [3, 5, 8] });
    const { customerId, subscription } = await trialing("charge-declined");
    await fake.advanceClock(customerId, 7 * DAY_SEC + 2 * 3600);
    const pastDue = await fake.retrieveSubscription(subscription.id);
    expect(pastDue?.status).toBe("past_due");
    const invoice = await fake.retrieveInvoice(pastDue?.latestInvoiceId ?? "");
    expect(invoice?.attemptCount).toBe(1);
    expect(invoice?.nextPaymentAttempt).not.toBeNull();
    await fake.advanceClock(customerId, 5 * DAY_SEC);
    expect((await fake.retrieveInvoice(invoice?.id ?? ""))?.attemptCount).toBe(3);
    expect((await fake.retrieveSubscription(subscription.id))?.status).toBe("past_due");
    await fake.advanceClock(customerId, 4 * DAY_SEC);
    const ended = await fake.retrieveSubscription(subscription.id);
    expect(ended?.status).toBe("canceled");
    expect((await fake.retrieveInvoice(invoice?.id ?? ""))?.status).toBe("void");
    const types = delivered.map((event) => event.type);
    expect(types.filter((type) => type === "invoice.payment_failed")).toHaveLength(4);
    expect(types).toContain("customer.subscription.deleted");
  });

  it("marks the subscription unpaid instead when configured, and recovers it on payment", async () => {
    const { fake, trialing, member } = await setup({ retriesExhausted: "unpaid" });
    const { customerId, subscription } = await trialing("charge-declined");
    await fake.advanceClock(customerId, 30 * DAY_SEC);
    const unpaid = await fake.retrieveSubscription(subscription.id);
    expect(unpaid?.status).toBe("unpaid");
    // The member replaces the card; changing the card does not attempt the invoice (§5.4).
    const setupIntent = await fake.createSetup({ customerId }, key());
    await fake.confirmSetup(setupIntent.clientSecret ?? "", "mastercard");
    const card = (await fake.retrieveSetup(setupIntent.id))?.paymentMethod?.id ?? "";
    await fake.setDefaultPaymentMethod(
      { customerId, paymentMethodId: card, subscriptionId: subscription.id },
      key(),
    );
    expect((await fake.retrieveSubscription(subscription.id))?.status).toBe("unpaid");
    const paid = await fake.payInvoice({ invoiceId: unpaid?.latestInvoiceId ?? "" }, key());
    expect(paid.status).toBe("paid");
    expect((await fake.retrieveSubscription(subscription.id))?.status).toBe("active");
    void member;
  });

  it("does not retry a renewal that needs a challenge, and offers it to the member", async () => {
    const { fake, trialing, delivered } = await setup();
    const { customerId, subscription } = await trialing("authentication-required");
    await fake.advanceClock(customerId, 7 * DAY_SEC + 2 * 3600);
    const pastDue = await fake.retrieveSubscription(subscription.id);
    expect(pastDue?.status).toBe("past_due");
    expect(pastDue?.paymentClientSecret).toBeTruthy();
    const invoice = await fake.retrieveInvoice(pastDue?.latestInvoiceId ?? "");
    expect(invoice?.nextPaymentAttempt).toBeNull();
    expect(delivered.map((event) => event.type)).toContain("invoice.payment_action_required");
    const outcome = await fake.confirmPayment(pastDue?.paymentClientSecret ?? "", null);
    expect(outcome.status).toBe("requires_action");
    expect(
      await fake.confirmPayment(pastDue?.paymentClientSecret ?? "", null, {
        challenge: "complete",
      }),
    ).toEqual({ status: "succeeded" });
    expect((await fake.retrieveSubscription(subscription.id))?.status).toBe("active");
  });

  it("expires an unconfirmed first payment after 23 hours", async () => {
    const { fake, member } = await setup();
    const { customerId, paymentMethodId } = await member();
    const created = await fake.createSubscription(
      {
        customerId,
        priceLookupKey: TEST_PRICES.basic.lookupKey,
        paymentMethodId,
        trialDays: null,
        promotionId: null,
      },
      key(),
    );
    expect(created.status).toBe("incomplete");
    await fake.advanceClock(customerId, 24 * 3600);
    const expired = await fake.retrieveSubscription(created.id);
    expect(expired?.status).toBe("incomplete_expired");
    expect((await fake.retrieveInvoice(created.latestInvoiceId ?? ""))?.status).toBe("void");
  });

  it("ends a trial set to cancel without charging, and sends the trial-ending hint before", async () => {
    const { fake, trialing, delivered } = await setup();
    const { customerId, subscription } = await trialing();
    await fake.setCancelAtPeriodEnd(
      { subscriptionId: subscription.id, cancelAtPeriodEnd: true },
      key(),
    );
    await fake.advanceClock(customerId, 5 * DAY_SEC);
    expect(delivered.map((event) => event.type)).toContain("customer.subscription.trial_will_end");
    await fake.advanceClock(customerId, 3 * DAY_SEC);
    const ended = await fake.retrieveSubscription(subscription.id);
    expect(ended?.status).toBe("canceled");
    const invoices = await fake.listInvoices({ customerId, limit: 10 });
    expect(invoices.every((invoice) => invoice.amountPaidMinor === 0)).toBe(true);
  });

  it("only moves forward", async () => {
    const { fake, member } = await setup();
    const { customerId } = await member();
    expect(await failure(fake.advanceClock(customerId, -1))).toBe("invalid_request");
  });
});

describe("fake provider: cards", () => {
  it.each([
    ["declined", "card_declined"],
    ["insufficient-funds", "insufficient_funds"],
    ["expired-card", "expired_card"],
    ["incorrect-cvc", "incorrect_cvc"],
    ["processing-error", "processing_error"],
    ["lost-card", "card_declined"],
  ] as const)("refuses %s at setup with %s", async (card, code) => {
    const { fake } = await setup();
    const customer = await fake.createCustomer({ accountId: "a", email: "a@example.test" }, key());
    const created = await fake.createSetup({ customerId: customer.id }, key());
    expect(await fake.confirmSetup(created.clientSecret ?? "", card)).toEqual({
      status: "failed",
      code,
    });
    expect(await fake.retrieveSetup(created.id)).toMatchObject({
      status: "failed",
      failureCode: code,
      paymentMethod: null,
    });
  });

  it("asks for a challenge at setup, then saves the card; a failed challenge saves nothing", async () => {
    const { fake } = await setup();
    const customer = await fake.createCustomer({ accountId: "a", email: "a@example.test" }, key());
    const first = await fake.createSetup({ customerId: customer.id }, key());
    expect(await fake.confirmSetup(first.clientSecret ?? "", "challenge")).toEqual({
      status: "requires_action",
    });
    expect((await fake.retrieveSetup(first.id))?.status).toBe("requires_confirmation");
    expect(
      await fake.confirmSetup(first.clientSecret ?? "", null, { challenge: "complete" }),
    ).toEqual({ status: "succeeded" });
    const second = await fake.createSetup({ customerId: customer.id }, key());
    await fake.confirmSetup(second.clientSecret ?? "", "challenge");
    expect(await fake.confirmSetup(second.clientSecret ?? "", null, { challenge: "fail" })).toEqual(
      { status: "failed", code: "authentication_required" },
    );
  });

  it("refuses a client secret that does not match", async () => {
    const { fake } = await setup();
    const customer = await fake.createCustomer({ accountId: "a", email: "a@example.test" }, key());
    const created = await fake.createSetup({ customerId: customer.id }, key());
    const forged = `${created.id}_secret_aaaaaaaaaaaa`;
    expect(await failure(fake.confirmSetup(forged, "visa"))).toBe("not_found");
  });
});

describe("fake provider: webhook delivery", () => {
  it("delivers in order, once each, by default", async () => {
    const { fake, delivered, trialing } = await setup();
    await trialing();
    const listed = await fake.listEvents({ createdAfter: 0, limit: 1000 });
    expect(delivered.map((event) => event.id)).toEqual(listed.map((event) => event.id));
  });

  it("delivers out of order and twice when unruly, and nothing during an outage", async () => {
    const { fake, delivered, trialing } = await setup();
    await fake.setDeliveryPolicy({ mode: "unruly", duplicateRate: 0.5, maxDelayMs: 0, seed: 7 });
    for (let i = 0; i < 3; i += 1) await trialing();
    const listed = await fake.listEvents({ createdAfter: 0, limit: 1000 });
    const ids = delivered.map((event) => event.id);
    expect(new Set(ids)).toEqual(new Set(listed.map((event) => event.id)));
    expect(ids.length).toBeGreaterThan(listed.length);

    await fake.setDeliveryPolicy({ mode: "outage" });
    const before = delivered.length;
    await trialing();
    await fake.deliverPending();
    expect(delivered.length).toBe(before);
    // Still listable: reconciliation is the way back after an outage.
    expect((await fake.listEvents({ createdAfter: 0, limit: 1000 })).length).toBeGreaterThan(
      listed.length,
    );
  });

  it("keeps a delivery the receiver refused and retries it on the next pump", async () => {
    const fake = new FakePaymentProvider({
      store: new MemoryFakeStore(),
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    let down = true;
    const received: string[] = [];
    fake.attachWebhookReceiver(async ({ body, signature }) => {
      if (down) throw new Error("503");
      received.push((await fake.parseWebhook(body, signature)).id);
    });
    await fake.createCustomer({ accountId: "a", email: "a@example.test" }, key());
    expect(received).toHaveLength(0);
    down = false;
    expect(await fake.deliverPending()).toMatchObject({ delivered: 1, pending: 0 });
    expect(received).toHaveLength(1);
  });

  it("signs like Stripe: a tampered body, another secret or an old timestamp is refused", async () => {
    const { fake, member } = await setup();
    await member();
    const [event] = await fake.listEvents({ createdAfter: 0, limit: 1 });
    if (!event) throw new Error("no event");
    const good = await fake.signedDelivery(event);
    expect((await fake.parseWebhook(good.body, good.signature)).id).toBe(event.id);
    const other = new FakePaymentProvider({
      store: new MemoryFakeStore(),
      webhookSecret: "whsec_other",
    });
    const foreign = await other.signedDelivery(event);
    await expect(fake.parseWebhook(foreign.body, foreign.signature)).rejects.toThrow();
    const old = await fake.signedDelivery(event, { ageSec: 301 });
    await expect(fake.parseWebhook(old.body, old.signature)).rejects.toThrow();
    const extra = `${good.signature},v0=ignored,v1=deadbeef`;
    expect((await fake.parseWebhook(good.body, extra)).id).toBe(event.id);
  });
});
