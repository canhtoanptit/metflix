import { AppError } from "@webflix/core";
import { describe, expect, it } from "vitest";
import { createBillingHarness, DAY_MS } from "./harness.ts";

const DAY_SEC = DAY_MS / 1000;

async function problem(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "expected an AppError").toBeInstanceOf(AppError);
  return (error as AppError).code;
}

describe("billing journeys against the fake provider", () => {
  it("starts with a trial: card first, then trialing once the provider has it, entitled", async () => {
    const h = await createBillingHarness();
    const auth = await h.account();
    const before = await h.services.account.getAccount(auth.session.accountId);
    expect(before.membership).toMatchObject({ status: "none", provider: null });
    expect(before.entitlement).toMatchObject({ entitled: false, reason: "no_membership" });

    const started = await h.services.billing.startCheckout(auth, { planId: "standard" });
    expect(started).toMatchObject({ status: "requires_setup", trial: null, amountDue: null });
    expect(started.clientSecret).toMatch(/_secret_/);
    // The card is confirmed in the provider's form first; confirming before is out of order.
    expect(
      await problem(h.services.billing.confirmCheckout(auth.session.accountId, started.id)),
    ).toBe("checkout_state_conflict");
    await h.confirm(started.clientSecret, "visa");
    const confirmed = await h.services.billing.confirmCheckout(auth.session.accountId, started.id);
    expect(confirmed.trial).toMatchObject({ days: 7 });
    expect(confirmed.amountDue).toEqual({ amountMinor: 0, currency: "USD" });
    expect(confirmed.clientSecret).toBeNull();
    await h.drain();

    const after = await h.services.account.getAccount(auth.session.accountId);
    expect(after.membership).toMatchObject({
      status: "trialing",
      planId: "standard",
      provider: "fake",
      cancelAtPeriodEnd: false,
    });
    expect(after.membership?.trialEndsAt).not.toBeNull();
    expect(after.entitlement).toMatchObject({
      entitled: true,
      maxStreams: 2,
      maxVideoHeight: 1080,
    });
    expect(after.subscription?.status).toBe("active");
    expect(after.paymentMethod).toMatchObject({ brand: "visa", last4: "4242" });
    expect((await h.services.billing.getCheckout(auth.session.accountId, started.id)).status).toBe(
      "complete",
    );
    // A second checkout while entitled is refused.
    expect(await problem(h.services.billing.startCheckout(auth, { planId: "basic" }))).toBe(
      "checkout_state_conflict",
    );
  });

  it("gives one trial per card: the same card on another account pays at once, activated by the provider's event", async () => {
    const h = await createBillingHarness();
    const first = await h.account();
    await h.subscribe(first, { card: "visa" });
    expect((await h.services.billing.membership(first.session.accountId, null)).state.status).toBe(
      "trialing",
    );

    const second = await h.account();
    const started = await h.services.billing.startCheckout(second, { planId: "basic" });
    await h.confirm(started.clientSecret, "visa");
    const confirmed = await h.services.billing.confirmCheckout(
      second.session.accountId,
      started.id,
    );
    expect(confirmed).toMatchObject({
      status: "requires_payment",
      trial: null,
      amountDue: { amountMinor: 799, currency: "USD" },
    });
    expect(confirmed.clientSecret).toBeTruthy();
    expect((await h.services.billing.membership(second.session.accountId, null)).state.status).toBe(
      "incomplete",
    );
    // The browser pays in the provider's form; nothing changes here until the provider says so.
    await h.fake.confirmPayment(confirmed.clientSecret ?? "", null);
    const pending = await h.services.billing.membership(second.session.accountId, null);
    expect(pending.state.status).toBe("incomplete");
    expect(pending.entitlement).toMatchObject({ entitled: false, reason: "payment_pending" });
    await h.drain();
    const active = await h.services.billing.membership(second.session.accountId, null);
    expect(active.state.status).toBe("active");
    expect(active.entitlement.entitled).toBe(true);
  });

  it("gives one trial per account too, even with another card", async () => {
    const h = await createBillingHarness();
    const auth = await h.account();
    await h.subscribe(auth, { card: "visa" });
    const record = await h.repos.billing.getMembership(auth.session.accountId);
    await h.fake.cancelNow(
      { subscriptionId: record?.providerSubscriptionId ?? "" },
      { idempotencyKey: "test-cancel-1" },
    );
    await h.drain();
    expect((await h.services.billing.membership(auth.session.accountId, null)).state.status).toBe(
      "canceled",
    );
    const restart = await h.services.billing.startCheckout(auth, { planId: "standard" });
    await h.confirm(restart.clientSecret, "mastercard");
    const confirmed = await h.services.billing.confirmCheckout(auth.session.accountId, restart.id);
    expect(confirmed.trial).toBeNull();
    expect(confirmed.status).toBe("requires_payment");
  });

  it("refuses a declined card at confirmation and lets the member try another in the same checkout", async () => {
    const h = await createBillingHarness();
    const auth = await h.account();
    const started = await h.services.billing.startCheckout(auth, { planId: "standard" });
    const outcome = await h.fake.confirmSetup(started.clientSecret ?? "", "insufficient-funds");
    expect(outcome).toEqual({ status: "failed", code: "insufficient_funds" });
    expect(
      await problem(h.services.billing.confirmCheckout(auth.session.accountId, started.id)),
    ).toBe("payment_declined");
    const retry = await h.services.billing.getCheckout(auth.session.accountId, started.id);
    expect(retry.status).toBe("requires_setup");
    expect(retry.failureReason).toBe("insufficient_funds");
    expect(retry.clientSecret).not.toBe(started.clientSecret);
    await h.confirm(retry.clientSecret, "visa");
    const confirmed = await h.services.billing.confirmCheckout(auth.session.accountId, started.id);
    expect(confirmed.trial).toMatchObject({ days: 7 });
  });

  it("completes a challenge on the first payment", async () => {
    const h = await createBillingHarness();
    const used = await h.account();
    await h.subscribe(used, { card: "challenge" });
    const auth = await h.account();
    const started = await h.services.billing.startCheckout(auth, { planId: "premium" });
    await h.confirm(started.clientSecret, "challenge");
    const confirmed = await h.services.billing.confirmCheckout(auth.session.accountId, started.id);
    expect(confirmed.status).toBe("requires_payment");
    expect(
      await h.fake.confirmPayment(confirmed.clientSecret ?? "", "authentication-required"),
    ).toEqual({
      status: "requires_action",
    });
    expect(
      await h.fake.confirmPayment(confirmed.clientSecret ?? "", null, { challenge: "complete" }),
    ).toEqual({ status: "succeeded" });
    await h.drain();
    expect((await h.services.billing.getCheckout(auth.session.accountId, started.id)).status).toBe(
      "complete",
    );
  });

  it("applies a promo code read before use, and refuses an exhausted one with the reason", async () => {
    const h = await createBillingHarness();
    await h.fake.definePromotion({ code: "HALF", percentOff: 50, maxRedemptions: 1 });
    const quote = await h.services.billing.validatePromotion({ code: "half", planId: "premium" });
    expect(quote).toMatchObject({
      promotion: { code: "HALF", percentOff: 50 },
      price: { amountMinor: 1899 },
      discountedPrice: { amountMinor: 949 },
    });
    const used = await h.account();
    await h.subscribe(used, { card: "visa" });
    const auth = await h.account();
    const started = await h.services.billing.startCheckout(auth, {
      planId: "premium",
      promotionCode: "HALF",
    });
    expect(started.promotion).toMatchObject({ code: "HALF", percentOff: 50 });
    await h.confirm(started.clientSecret, "visa");
    const confirmed = await h.services.billing.confirmCheckout(auth.session.accountId, started.id);
    expect(confirmed.amountDue).toEqual({ amountMinor: 949, currency: "USD" });
    const another = await h.account();
    const refused = await h.services.billing
      .startCheckout(another, { planId: "basic", promotionCode: "HALF" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).code).toBe("promotion_code_invalid");
    expect(
      await problem(h.services.billing.validatePromotion({ code: "NOPE", planId: "basic" })),
    ).toBe("promotion_code_invalid");
  });

  it("previews a plan change and applies exactly the preview, once, however often it is retried", async () => {
    const h = await createBillingHarness();
    const used = await h.account();
    await h.subscribe(used, { card: "visa" });
    const auth = await h.account();
    await h.subscribe(auth, { plan: "standard", card: "visa" });
    const accountId = auth.session.accountId;
    expect((await h.services.billing.membership(accountId, null)).state.status).toBe("active");

    h.clock.advance(10 * DAY_MS);
    const preview = await h.services.billing.previewPlanChange(accountId, "premium");
    expect(preview.amountDue.amountMinor).toBeGreaterThan(0);
    expect(preview.amountDue.amountMinor).toBeLessThan(1899 - 1299);
    h.clock.advance(60_000);
    const changed = await h.services.billing.changePlan(accountId, {
      planId: "premium",
      previewToken: preview.previewToken,
    });
    expect(changed.plan.id).toBe("premium");
    const invoices = await h.services.billing.listInvoices(accountId, {});
    const proration = invoices.items.find((invoice) => invoice.description === "Plan change");
    expect(proration?.amountPaid.amountMinor).toBe(preview.amountDue.amountMinor);
    expect(proration?.total.amountMinor).toBe(
      preview.lines.reduce((sum, line) => sum + line.amount.amountMinor, 0),
    );
    // A retried apply (the same preview) never charges again.
    await h.services.billing
      .changePlan(accountId, { planId: "premium", previewToken: preview.previewToken })
      .catch(() => undefined);
    const record = await h.repos.billing.getMembership(accountId);
    const all = await h.fake.listInvoices({
      customerId: record?.providerCustomerId ?? "",
      limit: 50,
    });
    expect(all.filter((invoice) => invoice.billingReason === "subscription_update")).toHaveLength(
      1,
    );
    // A tampered or foreign preview token is refused.
    expect(
      await problem(
        h.services.billing.changePlan(accountId, {
          planId: "basic",
          previewToken: preview.previewToken,
        }),
      ),
    ).toBe("checkout_state_conflict");
  });

  it("downgrades with a credit that pays the next renewal", async () => {
    const h = await createBillingHarness();
    const used = await h.account();
    await h.subscribe(used, { card: "visa" });
    const auth = await h.account();
    await h.subscribe(auth, { plan: "premium" });
    const accountId = auth.session.accountId;
    const preview = await h.services.billing.previewPlanChange(accountId, "basic");
    expect(preview.amountDue.amountMinor).toBe(0);
    expect(preview.credit.amountMinor).toBeGreaterThan(0);
    const changed = await h.services.billing.changePlan(accountId, {
      planId: "basic",
      previewToken: preview.previewToken,
    });
    expect(changed.plan.id).toBe("basic");
    expect(preview.nextRenewal?.amount.amountMinor).toBe(
      Math.max(0, 799 - preview.credit.amountMinor),
    );
  });

  it("cancels at the period end (still entitled), resumes, and ends at the period end", async () => {
    const h = await createBillingHarness();
    const used = await h.account();
    await h.subscribe(used, { card: "visa" });
    const auth = await h.account();
    await h.subscribe(auth);
    const accountId = auth.session.accountId;
    const canceled = await h.services.billing.cancel(accountId);
    expect(canceled.subscription.status).toBe("canceling");
    const snapshot = await h.services.billing.membership(accountId, null);
    expect(snapshot.state).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    expect(snapshot.entitlement.entitled).toBe(true);
    expect(snapshot.entitlement.until).not.toBeNull();
    const resumed = await h.services.billing.resume(accountId);
    expect(resumed.subscription.status).toBe("active");
    await h.services.billing.cancel(accountId);
    // Past the period end: ended by time, and by the provider once it is read.
    h.clock.advance(31 * DAY_MS);
    expect((await h.services.billing.membership(accountId, null)).state.status).toBe("canceled");
    await h.services.billing.syncAccount(accountId);
    await h.drain();
    const ended = await h.services.billing.membership(accountId, null);
    expect(ended.state.status).toBe("canceled");
    expect(ended.entitlement).toMatchObject({ entitled: false, reason: "ended" });
    expect(await problem(h.services.billing.resume(accountId))).toBe("checkout_state_conflict");
  });

  it("fails a renewal, retries it, keeps the member through grace, suspends, and recovers with a new card", async () => {
    const h = await createBillingHarness({ fake: { retriesExhausted: "unpaid" } });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { card: "charge-declined" });
    expect((await h.services.billing.membership(accountId, null)).state.status).toBe("trialing");

    // The trial ends; the renewal is collected an hour later and declines.
    await h.services.billing.advanceClock(accountId, 7 * DAY_SEC + 2 * 3600);
    await h.drain();
    const pastDue = await h.services.billing.membership(accountId, null);
    expect(pastDue.state.status).toBe("past_due");
    expect(pastDue.entitlement.entitled).toBe(true);
    expect(pastDue.state.graceEndsAt).not.toBeNull();
    const record = await h.repos.billing.getMembership(accountId);
    expect(record?.graceStartedAt).not.toBeNull();

    // The provider retries on its schedule; each failure keeps the grace start where it was.
    await h.services.billing.advanceClock(accountId, 4 * DAY_SEC);
    await h.drain();
    expect((await h.repos.billing.getMembership(accountId))?.graceStartedAt).toBe(
      record?.graceStartedAt,
    );
    expect((await h.services.billing.membership(accountId, null)).state.status).toBe("past_due");

    // Grace (7 days) runs out before the provider stops retrying (day 8): suspended by time.
    await h.services.billing.advanceClock(accountId, 3 * DAY_SEC + 3600);
    await h.drain();
    const suspended = await h.services.billing.membership(accountId, null);
    expect(suspended.state).toMatchObject({
      status: "suspended",
      suspendedReason: "grace_expired",
    });
    expect(suspended.entitlement).toMatchObject({ entitled: false, reason: "suspended" });

    // A second subscription is never the way back: the open invoice is.
    expect(await problem(h.services.billing.startCheckout(auth, { planId: "basic" }))).toBe(
      "checkout_state_conflict",
    );

    // Card replaced through a setup; the provider's event makes it the default and the open
    // invoice is paid explicitly (a card change alone does not attempt it).
    const setup = await h.services.billing.setupPaymentMethod(accountId);
    expect(setup.status).toBe("requires_confirmation");
    await h.confirm(setup.clientSecret, "mastercard");
    await h.drain();
    const recovered = await h.services.billing.membership(accountId, null);
    expect(recovered.state.status).toBe("active");
    expect(recovered.entitlement.entitled).toBe(true);
    expect(recovered.paymentMethod).toMatchObject({ brand: "mastercard", last4: "4444" });
    expect((await h.services.billing.getPaymentMethodSetup(accountId, setup.id)).status).toBe(
      "succeeded",
    );
  });

  it("ends the subscription when retries run out (cancel), and restarts it without a second trial", async () => {
    const h = await createBillingHarness({ fake: { retriesExhausted: "cancel" } });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { card: "charge-declined" });
    await h.services.billing.advanceClock(accountId, 20 * DAY_SEC);
    await h.drain();
    expect((await h.services.billing.membership(accountId, null)).state.status).toBe("canceled");
    const restart = await h.services.billing.startCheckout(auth, { planId: "standard" });
    await h.confirm(restart.clientSecret, "mastercard");
    const confirmed = await h.services.billing.confirmCheckout(accountId, restart.id);
    expect(confirmed.trial).toBeNull();
    await h.confirm(confirmed.clientSecret, null);
    await h.drain();
    expect((await h.services.billing.membership(accountId, null)).state.status).toBe("active");
  });

  it("returns an unconfirmed first payment to no membership after the provider expires it", async () => {
    const h = await createBillingHarness();
    const used = await h.account();
    await h.subscribe(used, { card: "visa" });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    const started = await h.services.billing.startCheckout(auth, { planId: "basic" });
    await h.confirm(started.clientSecret, "visa");
    await h.services.billing.confirmCheckout(accountId, started.id);
    expect((await h.services.billing.membership(accountId, null)).state.status).toBe("incomplete");
    await h.services.billing.advanceClock(accountId, 24 * 3600);
    await h.drain();
    expect((await h.services.billing.membership(accountId, null)).state.status).toBe("none");
    expect((await h.services.billing.getCheckout(accountId, started.id)).status).toBe("expired");
    // The member resumes at plan choice.
    const again = await h.services.billing.startCheckout(auth, { planId: "basic" });
    expect(again.status).toBe("requires_setup");
  });

  it("resumes a checkout the member left half-way", async () => {
    const h = await createBillingHarness();
    const auth = await h.account();
    const started = await h.services.billing.startCheckout(auth, { planId: "standard" });
    const resumed = await h.services.billing.startCheckout(auth, { planId: "premium" });
    expect(resumed.id).toBe(started.id);
    expect(resumed.planId).toBe("premium");
    expect(resumed.clientSecret).toBe(started.clientSecret);
  });

  it("lists invoices newest first with cursors", async () => {
    const h = await createBillingHarness();
    const used = await h.account();
    await h.subscribe(used, { card: "visa" });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { plan: "basic" });
    await h.services.billing.advanceClock(accountId, 31 * DAY_SEC);
    await h.drain();
    await h.services.billing.advanceClock(accountId, 31 * DAY_SEC);
    await h.drain();
    const first = await h.services.billing.listInvoices(accountId, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const rest = await h.services.billing.listInvoices(accountId, {
      limit: 10,
      cursor: first.nextCursor ?? "",
    });
    const all = [...first.items, ...rest.items];
    expect(all.length).toBeGreaterThanOrEqual(3);
    const times = all.map((invoice) => Date.parse(invoice.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(await problem(h.services.billing.listInvoices(accountId, { cursor: "garbage" }))).toBe(
      "validation_failed",
    );
  });

  it("serves the provider configuration and the plans with their trial", async () => {
    const h = await createBillingHarness();
    expect(h.services.billing.config()).toEqual({ provider: "fake", formUrl: "/_pay/form" });
    const plans = await h.services.billing.plans();
    expect(plans.items.map((plan) => plan.id)).toEqual(["basic", "standard", "premium"]);
    expect(plans.items.every((plan) => plan.trial?.days === 7)).toBe(true);
  });
});
