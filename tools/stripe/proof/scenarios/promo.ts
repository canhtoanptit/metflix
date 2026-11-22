import type Stripe from "stripe";
import { browserConfirm } from "../client.ts";
import { DAY, HOUR, nowSeconds } from "../clock.ts";
import type { Scenario } from "../context.ts";
import { createTimeline } from "../timeline.ts";
import { createCustomer, intentIdFromClientSecret, lookupKey, priceIds } from "./helpers.ts";

const SHORT_LIVED_SECONDS = 60;

async function subscribeWithCode(
  s: Scenario,
  customer: Stripe.Customer,
  price: string,
  promotionCode: string,
  label: string,
) {
  try {
    const sub = await s.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price }],
      discounts: [{ promotion_code: promotionCode }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.confirmation_secret"],
    });
    s.own(sub.id);
    s.record(`subscription with promotion code (${label})`, sub);
    const invoice = sub.latest_invoice as Stripe.Invoice;
    s.own(invoice.id);
    const secret = invoice.confirmation_secret?.client_secret;
    if (secret) {
      const confirm = await browserConfirm(
        s.publishableKey,
        "payment_intents",
        intentIdFromClientSecret(secret),
        secret,
        "pm_card_visa",
      );
      s.responses.push({
        step: s.currentStep,
        label: `browser pays (${label})`,
        at: new Date().toISOString(),
        status: confirm.status,
        body: confirm.body,
      });
    }
    return {
      ok: true as const,
      subtotal: invoice.subtotal,
      total: invoice.total,
      discounts: invoice.total_discount_amounts?.map((d) => d.amount) ?? [],
    };
  } catch (error) {
    return {
      ok: false as const,
      error: s.recordError(`subscription with promotion code refused (${label})`, error),
    };
  }
}

export async function promotionCodes(s: Scenario): Promise<void> {
  const prices = await priceIds(s.stripe);
  const price = prices[lookupKey("basic", "usd")] as string;
  const suffix = s.runId.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  const { limited, shortLived } = await s.step("create a coupon and two codes", async () => {
    const coupon = await s.stripe.coupons.create({
      id: `webflix-proof-half-${s.runId}`,
      percent_off: 50,
      duration: "once",
      name: "Proof: half the first month",
    });
    s.own(coupon.id);
    s.record("coupon", coupon);
    const limited = await s.stripe.promotionCodes.create({
      promotion: { type: "coupon", coupon: coupon.id },
      code: `HALF${suffix}`,
      max_redemptions: 1,
      expires_at: nowSeconds() + 3 * DAY,
    });
    s.own(limited.id);
    s.record("promotion code, one redemption, 3-day expiry", limited);
    const shortLived = await s.stripe.promotionCodes.create({
      promotion: { type: "coupon", coupon: coupon.id },
      code: `SOON${suffix}`,
      expires_at: nowSeconds() + SHORT_LIVED_SECONDS,
    });
    s.own(shortLived.id);
    s.record(`promotion code expiring in ${SHORT_LIVED_SECONDS} s (real time)`, shortLived);
    return { limited, shortLived };
  });

  const time = await createTimeline(s, s.timeMode, "promo");

  await s.step("first member redeems the limited code", async () => {
    const customer = await createCustomer(s, time, "first");
    const result = await subscribeWithCode(s, customer, price, limited.id, "first");
    s.observe("first redemption", result);
    s.expect("first redemption succeeds", result.ok, true);
    await s.settle(3000);
    const code = await s.stripe.promotionCodes.retrieve(limited.id);
    s.record("limited code after one redemption", code);
    s.observe("limited code after one redemption", {
      times_redeemed: code.times_redeemed,
      active: code.active,
    });
  });

  await s.step("second member is refused (redemption limit)", async () => {
    const customer = await createCustomer(s, time, "second");
    const result = await subscribeWithCode(s, customer, price, limited.id, "second");
    s.observe("second redemption", result);
    s.expect("second redemption refused", result.ok, false);
  });

  await s.step("expiry against the test clock, not real time", async () => {
    if (
      !time.requireClock(
        "promotion-code expiry for a customer whose test clock is past it (real time is not)",
      )
    )
      return;
    await time.advance(
      (await time.now()) + 3 * HOUR,
      "3 hours, past the short-lived code's expiry",
    );
    const customer = await createCustomer(s, time, "clock-ahead");
    const result = await subscribeWithCode(
      s,
      customer,
      price,
      shortLived.id,
      "clock past expiry, real time before",
    );
    s.observe(
      "a code that has expired in clock time but not in real time",
      result,
      undefined,
      "tells the adapter's author which time Stripe checks promotion-code expiry against for clock customers",
    );
  });

  await s.step("expired in real time", async () => {
    const wait = (shortLived.expires_at as number) + 5 - nowSeconds();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    const customer = await createCustomer(s, null, "after-expiry");
    const result = await subscribeWithCode(s, customer, price, shortLived.id, "after expiry");
    s.observe("redemption after expiry", result);
    s.expect("redemption after expiry refused", result.ok, false);
    const code = await s.stripe.promotionCodes.retrieve(shortLived.id);
    s.observe("short-lived code after expiry", {
      active: code.active,
      times_redeemed: code.times_redeemed,
    });
  });
}
