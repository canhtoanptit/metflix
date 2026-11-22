import type Stripe from "stripe";
import { forCustomer, type Scenario } from "../context.ts";
import { createTimeline } from "../timeline.ts";
import { createCustomer, lookupKey, priceIds, subscribeTrial } from "./helpers.ts";

/**
 * The fingerprint of the card collected for a trial, read from the SetupIntent the browser
 * confirmed (the subscription's default_payment_method is set a moment later, asynchronously).
 */
async function trialCardFingerprint(
  s: Scenario,
  subscription: Stripe.Subscription,
): Promise<string | null> {
  const pending = subscription.pending_setup_intent;
  const id = typeof pending === "string" ? pending : pending?.id;
  if (!id) return null;
  const intent = await s.stripe.setupIntents.retrieve(id, { expand: ["payment_method"] });
  const pm = intent.payment_method as Stripe.PaymentMethod | null;
  if (pm) s.own(pm.id);
  s.observe("card collected for the trial", {
    brand: pm?.card?.brand ?? null,
    last4: pm?.card?.last4 ?? null,
  });
  return pm?.card?.fingerprint ?? null;
}

/**
 * Blueprint §5.4 wants one trial per account and per payment fingerprint. Does Stripe enforce
 * either? And is the card fingerprint stable across customers, so Webflix can enforce it?
 */
export async function trialOnce(s: Scenario): Promise<void> {
  const prices = await priceIds(s.stripe);
  const price = prices[lookupKey("basic", "usd")] as string;
  // No time passes here; a clock (when available) only keeps the customers grouped.
  const time = await createTimeline(s, s.timeMode, "trial-once");

  const a = await s.step("member A: trial, cancel, trial again", async () => {
    const customer = await createCustomer(s, time, "a");
    const first = await subscribeTrial(s, customer, price, "pm_card_visa", "a first");
    await s.waitForEvent("setup_intent.succeeded", forCustomer(customer.id));
    await s.stripe.subscriptions.cancel(first.id);
    const second = await subscribeTrial(s, customer, price, "pm_card_visa", "a second");
    s.expect("Stripe grants the same customer a second trial", second.status, "trialing");
    await s.waitForEvent(
      "setup_intent.succeeded",
      (o) =>
        forCustomer(customer.id)(o) &&
        o.id !== (first.pending_setup_intent as Stripe.SetupIntent | null)?.id,
    );
    return { customer, fingerprint: await trialCardFingerprint(s, second) };
  });

  await s.step("member B: same card number, another customer", async () => {
    const customer = await createCustomer(s, time, "b");
    const sub = await subscribeTrial(s, customer, price, "pm_card_visa", "b");
    await s.waitForEvent("setup_intent.succeeded", forCustomer(customer.id));
    const fingerprint = await trialCardFingerprint(s, sub);
    s.expect(
      "same card on another customer has the same fingerprint",
      fingerprint === a.fingerprint && fingerprint !== null,
      true,
    );
  });

  await s.step("member C: a different card", async () => {
    const customer = await createCustomer(s, time, "c");
    const sub = await subscribeTrial(s, customer, price, "pm_card_mastercard", "c");
    await s.waitForEvent("setup_intent.succeeded", forCustomer(customer.id));
    const fingerprint = await trialCardFingerprint(s, sub);
    s.expect(
      "a different card has a different fingerprint",
      fingerprint !== a.fingerprint && fingerprint !== null,
      true,
    );
  });
}
