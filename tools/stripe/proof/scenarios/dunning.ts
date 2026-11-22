import type Stripe from "stripe";
import { HOUR, nowSeconds } from "../clock.ts";
import { forCustomer, type Scenario } from "../context.ts";
import { createTimeline, type Timeline } from "../timeline.ts";
import {
  collectCard,
  createCustomer,
  lookupKey,
  priceIds,
  subscribeTrial,
  summariseSubscription,
  waitActive,
} from "./helpers.ts";

/**
 * A member whose card is accepted at sign-up (attaching 4000 0000 0000 0341 succeeds) and
 * declines when the first renewal is charged: the common "trial converts but payment fails".
 */
async function renewalFails(s: Scenario, time: Timeline) {
  const prices = await priceIds(s.stripe);
  const customer = await createCustomer(s, time, "member");
  const subscription = await s.step("subscribe with a card that will decline", async () => {
    const mark = s.mark();
    const sub = await subscribeTrial(
      s,
      customer,
      prices[lookupKey("standard", "usd")] as string,
      "pm_card_chargeCustomerFail",
      "member",
      time.trialParams(),
    );
    await s.waitForEvent("setup_intent.succeeded", forCustomer(customer.id), 90_000, mark);
    return sub;
  });

  const invoice = await s.step("first renewal fails", async () => {
    const mark = s.mark();
    const failed = await time.endTrialAndCollect(subscription, customer);
    s.record("renewal invoice after the failed attempt", failed);
    await s.waitForEvent("invoice.payment_failed", (o) => o.id === failed.id, 120_000, mark);
    await s.waitForEvent(
      "customer.subscription.updated",
      (o) => forCustomer(customer.id)(o) && o.status === "past_due",
      120_000,
      mark,
    );
    const sub = await s.stripe.subscriptions.retrieve(subscription.id);
    s.expect("subscription status after the failed renewal", sub.status, "past_due");
    s.observe("invoice after the failed renewal", {
      status: failed.status,
      attempt_count: failed.attempt_count,
      hours_until_stripe_retries: failed.next_payment_attempt
        ? Math.round(((failed.next_payment_attempt - (await time.now())) / 3600) * 10) / 10
        : null,
    });
    return failed;
  });
  return { customer, subscription, invoice };
}

export async function renewalRecovers(s: Scenario): Promise<void> {
  const time = await createTimeline(s, s.timeMode, "dunning");
  const { customer, subscription, invoice } = await renewalFails(s, time);

  await s.step("Stripe retries on its schedule", async () => {
    if (!time.requireClock("Stripe's own retry of the failed invoice at next_payment_attempt"))
      return;
    if (!invoice.next_payment_attempt) {
      s.observe("no retry scheduled", true);
      return;
    }
    const mark = s.mark();
    await time.advance(invoice.next_payment_attempt + HOUR, "first retry");
    const retried = await s.waitForEvent(
      "invoice.payment_failed",
      (o) => o.id === invoice.id && (o.attempt_count as number) >= 2,
      240_000,
      mark,
    );
    s.observe("retry failed too", {
      attempt_count: (retried.data.object as Stripe.Invoice).attempt_count,
      next_payment_attempt: (retried.data.object as Stripe.Invoice).next_payment_attempt,
    });
  });

  await s.step("member replaces the card and the invoice is paid", async () => {
    const pm = await collectCard(s, customer, "pm_card_visa", "replacement card");
    await s.stripe.subscriptions.update(subscription.id, { default_payment_method: pm });
    const before = await s.stripe.invoices.retrieve(invoice.id);
    s.observe(
      "invoice after the card change, before paying",
      { status: before.status, attempt_count: before.attempt_count },
      undefined,
      "changing the default card does not trigger a payment attempt; the adapter pays the open invoice",
    );
    const mark = s.mark();
    const paid = await s.stripe.invoices.pay(invoice.id);
    s.record("invoices.pay with the new default card", paid);
    s.expect("invoice status after pay", paid.status, "paid");
    await s.waitForEvent("invoice.paid", (o) => o.id === invoice.id, 120_000, mark);
    await waitActive(s, customer, "recovery", mark);
    const sub = await s.stripe.subscriptions.retrieve(subscription.id);
    s.expect("subscription status after recovery", sub.status, "active");
    s.observe("subscription after recovery", summariseSubscription(sub));
  });
}

export async function retriesExhausted(s: Scenario): Promise<void> {
  const time = await createTimeline(s, s.timeMode, "exhausted");
  const { subscription, invoice } = await renewalFails(s, time);

  await s.step("every retry fails until Stripe stops", async () => {
    if (!time.requireClock("Stripe's retries until it gives up, and the final subscription state"))
      return;
    const attempts: Array<{ attempt: number; at: string; next: string | null }> = [];
    let current = invoice;
    for (let i = 0; i < 12 && current.next_payment_attempt; i++) {
      const target = current.next_payment_attempt + HOUR;
      const mark = s.mark();
      await time.advance(target, `retry ${i + 1}`);
      const expected = (current.attempt_count ?? 0) + 1;
      const event = await s
        .waitForEvent(
          "invoice.payment_failed",
          (o) => o.id === invoice.id && (o.attempt_count as number) >= expected,
          240_000,
          mark,
        )
        .catch(() => null);
      current = await s.stripe.invoices.retrieve(invoice.id);
      attempts.push({
        attempt: current.attempt_count,
        at: new Date(target * 1000).toISOString(),
        next: current.next_payment_attempt
          ? new Date(current.next_payment_attempt * 1000).toISOString()
          : null,
      });
      if (!event) break;
    }
    s.observe("attempts (count includes the first failure)", attempts);
    await s.settle(8000);
    const finalInvoice = await s.stripe.invoices.retrieve(invoice.id);
    const finalSub = await s.stripe.subscriptions.retrieve(subscription.id);
    s.record("invoice after retries ended", finalInvoice);
    s.record("subscription after retries ended", finalSub);
    s.observe("final state with a fresh sandbox's default settings", {
      subscription: finalSub.status,
      invoice: finalInvoice.status,
      attempt_count: finalInvoice.attempt_count,
      next_payment_attempt: finalInvoice.next_payment_attempt,
      ended_at: finalSub.ended_at,
      cancellation_details: finalSub.cancellation_details,
      observed_at: nowSeconds(),
    });
  });
}
