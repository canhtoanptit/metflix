import type Stripe from "stripe";
import { DAY, HOUR } from "../clock.ts";
import { forCustomer, type Scenario } from "../context.ts";
import { createTimeline } from "../timeline.ts";
import {
  createCustomer,
  lookupKey,
  priceIds,
  subscribeTrial,
  summariseSubscription,
} from "./helpers.ts";

/**
 * Sign-up with a trial and the card collected up front (blueprint §5.4): the subscription starts
 * `trialing` with a `pending_setup_intent`; the browser confirms it; Stripe warns before the end
 * (`trial_will_end`); at the end it invoices and charges; the subscription is `active`.
 */
export async function trialConverts(s: Scenario): Promise<void> {
  const prices = await priceIds(s.stripe);
  const time = await createTimeline(s, s.timeMode, "trial");
  const customer = await createCustomer(s, time, "member");

  const subscription = await s.step("subscribe with a trial", async () => {
    const mark = s.mark();
    const sub = await subscribeTrial(
      s,
      customer,
      prices[lookupKey("basic", "usd")] as string,
      "pm_card_visa",
      "member",
      time.trialParams(),
    );
    s.expect("status at creation", sub.status, "trialing");
    s.observe("pending_setup_intent at creation", sub.pending_setup_intent ? "present" : "absent");
    s.observe("latest_invoice at creation (the zero trial invoice)", {
      total: (sub.latest_invoice as Stripe.Invoice | null)?.total ?? null,
      status: (sub.latest_invoice as Stripe.Invoice | null)?.status ?? null,
    });
    await s.waitForEvent("setup_intent.succeeded", forCustomer(customer.id), 90_000, mark);
    await s.settle(3000);
    const after = await s.stripe.subscriptions.retrieve(sub.id);
    s.record("subscription after the browser confirmed the SetupIntent", after);
    s.expect(
      "default_payment_method saved on the subscription",
      after.default_payment_method !== null,
      true,
    );
    s.observe("subscription after card collected", summariseSubscription(after));
    return after;
  });

  const trialEnd = subscription.trial_end;
  if (!trialEnd) throw new Error("trial_end missing");

  await s.step("Stripe warns that the trial ends soon", async () => {
    if (time.mode === "test-clock") {
      await time.advance(trialEnd - 3 * DAY + HOUR, "past trial_end minus 3 days");
    }
    // Docs: a trial shorter than three days gets the warning at once. Observed in real time
    // (40-second trials): sometimes it comes within seconds, sometimes never, so in real time
    // its absence is recorded, not failed; with a test clock it is required.
    const waitMs =
      time.mode === "test-clock"
        ? 120_000
        : Math.max(1, trialEnd + 10 - Math.floor(Date.now() / 1000)) * 1000;
    const warning = await s
      .waitForEvent("customer.subscription.trial_will_end", forCustomer(customer.id), waitMs)
      .catch((error: unknown) => {
        if (time.mode === "test-clock") throw error;
        return null;
      });
    s.observe("trial_will_end", {
      received: warning !== null,
      seconds_before_trial_end: warning ? trialEnd - warning.created : null,
      mode: time.mode,
    });
  });

  await s.step("trial ends and converts", async () => {
    const mark = s.mark();
    const invoice = await time.endTrialAndCollect(subscription, customer);
    s.record("first renewal invoice after the attempt", invoice);
    s.observe("first renewal invoice", {
      billing_reason: invoice.billing_reason,
      amount_paid: invoice.amount_paid,
      currency: invoice.currency,
      status: invoice.status,
    });
    s.expect("first renewal invoice paid", invoice.status, "paid");
    await s.waitForEvent("invoice.paid", (o) => o.id === invoice.id, 120_000, mark);
    const after = await s.stripe.subscriptions.retrieve(subscription.id);
    s.record("subscription after conversion", after);
    s.expect("status after conversion", after.status, "active");
    s.observe("subscription after conversion", summariseSubscription(after));
  });
}
