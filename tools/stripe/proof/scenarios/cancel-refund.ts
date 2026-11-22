import type Stripe from "stripe";
import { DAY, HOUR } from "../clock.ts";
import { forCustomer, isObject, type Scenario } from "../context.ts";
import { createTimeline } from "../timeline.ts";
import {
  createCustomer,
  invoicePaymentIntent,
  lookupKey,
  priceIds,
  subscribePaid,
  subscribeTrial,
  summariseSubscription,
  waitActive,
} from "./helpers.ts";

function latestInvoiceId(subscription: Stripe.Subscription): string {
  const invoice = subscription.latest_invoice;
  const id = typeof invoice === "string" ? invoice : invoice?.id;
  if (!id) throw new Error("subscription without latest_invoice");
  return id;
}

export async function cancelAndRefund(s: Scenario): Promise<void> {
  const prices = await priceIds(s.stripe);
  const time = await createTimeline(s, s.timeMode, "cancel");
  const start = await time.now();

  const a = await s.step("member A subscribes", async () => {
    const customer = await createCustomer(s, time, "a");
    const { subscription } = await subscribePaid(
      s,
      customer,
      prices[lookupKey("basic", "usd")] as string,
      "pm_card_visa",
      "a",
    );
    await waitActive(s, customer, "A pays");
    return { customer, subscription };
  });

  await s.step("cancel at period end, then resume", async () => {
    let mark = s.mark();
    const canceling = await s.stripe.subscriptions.update(a.subscription.id, {
      cancel_at_period_end: true,
    });
    s.record("cancel_at_period_end: true", canceling);
    s.observe("after cancel_at_period_end", summariseSubscription(canceling));
    await s.waitForEvent(
      "customer.subscription.updated",
      (o) => isObject(a.subscription.id)(o) && o.cancel_at_period_end === true,
      90_000,
      mark,
    );
    mark = s.mark();
    const resumed = await s.stripe.subscriptions.update(a.subscription.id, {
      cancel_at_period_end: false,
    });
    s.record("cancel_at_period_end: false (resume)", resumed);
    s.observe("after resume", summariseSubscription(resumed));
    s.expect("resume clears cancel_at", resumed.cancel_at, null);
    await s.waitForEvent(
      "customer.subscription.updated",
      (o) => isObject(a.subscription.id)(o) && o.cancel_at_period_end === false,
      90_000,
      mark,
    );
  });

  await s.step("cancel immediately", async () => {
    const mark = s.mark();
    const canceled = await s.stripe.subscriptions.cancel(a.subscription.id);
    s.record("subscriptions.cancel (no invoice_now, no prorate)", canceled);
    s.expect("status", canceled.status, "canceled");
    await s.waitForEvent(
      "customer.subscription.deleted",
      isObject(a.subscription.id),
      90_000,
      mark,
    );
  });

  await s.step("refund A's payment: partial, then the rest", async () => {
    const invoiceId = latestInvoiceId(a.subscription);
    const intent = await invoicePaymentIntent(s, invoiceId);
    const mark = s.mark();
    const partial = await s.stripe.refunds.create({ payment_intent: intent, amount: 300 });
    s.own(partial.id);
    s.record("partial refund (300)", partial);
    const rest = await s.stripe.refunds.create({ payment_intent: intent });
    s.own(rest.id);
    s.record("refund of the remainder", rest);
    s.observe("refund amounts", {
      partial: partial.amount,
      rest: rest.amount,
      statuses: [partial.status, rest.status],
    });
    await s.waitForEvent(
      "charge.refunded",
      (o) => o.payment_intent === intent && o.refunded === true,
      90_000,
      mark,
    );
    const invoice = await s.stripe.invoices.retrieve(invoiceId);
    s.observe(
      "invoice after full refund",
      {
        status: invoice.status,
        amount_paid: invoice.amount_paid,
        amount_remaining: invoice.amount_remaining,
      },
      undefined,
      "a refund does not change the invoice",
    );
  });

  await s.step("member B: immediate cancel with prorated credit, full refund", async () => {
    const customer = await createCustomer(s, time, "b");
    const { subscription } = await subscribePaid(
      s,
      customer,
      prices[lookupKey("standard", "usd")] as string,
      "pm_card_visa",
      "b",
    );
    await waitActive(s, customer, "B pays");
    if (time.mode === "test-clock") await time.advance(start + 10 * DAY, "10 days in");
    const canceled = await s.stripe.subscriptions.cancel(subscription.id, {
      invoice_now: true,
      prorate: true,
    });
    s.record("subscriptions.cancel with invoice_now and prorate", canceled);
    await s.settle();
    const after = await s.stripe.customers.retrieve(customer.id);
    s.observe(
      "customer balance after a prorated immediate cancel (negative = credit)",
      (after as Stripe.Customer).balance,
    );
    const invoices = await s.stripe.invoices.list({ customer: customer.id, limit: 10 });
    s.record("B's invoices", invoices);
    s.observe(
      "B's invoices",
      invoices.data.map((i) => ({ reason: i.billing_reason, total: i.total, status: i.status })),
    );
    const intent = await invoicePaymentIntent(s, latestInvoiceId(subscription));
    const mark = s.mark();
    const refund = await s.stripe.refunds.create({ payment_intent: intent });
    s.own(refund.id);
    s.record("full refund", refund);
    await s.waitForEvent("charge.refunded", (o) => o.payment_intent === intent, 90_000, mark);
  });

  await s.step("member C: trial cancelled before it converts", async () => {
    const customer = await createCustomer(s, time, "c");
    const mark = s.mark();
    const sub = await subscribeTrial(
      s,
      customer,
      prices[lookupKey("basic", "usd")] as string,
      "pm_card_visa",
      "c",
      time.trialParams(),
    );
    await s.waitForEvent("setup_intent.succeeded", forCustomer(customer.id), 90_000, mark);
    const canceling = await s.stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
    s.record("trial set to cancel at its end", canceling);
    s.observe("trial set to cancel", summariseSubscription(canceling));
    const endMark = s.mark();
    if (time.mode === "test-clock")
      await time.advance((canceling.trial_end as number) + 2 * HOUR, "past the trial end");
    await s.waitForEvent("customer.subscription.deleted", isObject(sub.id), 240_000, endMark);
    const ended = await s.stripe.subscriptions.retrieve(sub.id);
    s.record("trial subscription after its end", ended);
    s.observe("trial subscription after its end", summariseSubscription(ended));
    const invoices = await s.stripe.invoices.list({ customer: customer.id, limit: 10 });
    s.record("C's invoices", invoices);
    s.expect(
      "C was never charged",
      invoices.data.reduce((sum, i) => sum + i.amount_paid, 0),
      0,
    );
  });
}
