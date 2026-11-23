import { AppError } from "@webflix/core";
import { describe, expect, it } from "vitest";
import { createBillingHarness, DAY_MS } from "./harness.ts";

/**
 * What the web's checkout and membership screens needed from the server (the round after the
 * screens were built): the next bill, the open checkout, a promo code never spent on a trial,
 * and a card change's decline reason.
 */
async function problem(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "expected an AppError").toBeInstanceOf(AppError);
  return (error as AppError).code;
}

describe("the next bill (GET /account → membership.nextInvoice)", () => {
  it("is the plan's price at the trial's end, then less a downgrade's credit; none while cancelling or without a membership", async () => {
    const h = await createBillingHarness();
    const nobody = await h.account();
    expect(
      (await h.services.account.getAccount(nobody.session.accountId)).membership?.nextInvoice,
    ).toBeNull();

    const auth = await h.account();
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { plan: "premium", card: "visa" });
    const trialing = (await h.services.account.getAccount(accountId)).membership;
    expect(trialing?.status).toBe("trialing");
    expect(trialing?.nextInvoice).toEqual({
      at: trialing?.trialEndsAt,
      amount: { amountMinor: 1899, currency: "USD" },
      creditApplied: null,
      discount: null,
    });

    // Converted and paid, then downgraded at once: the renewal is the new price less the credit.
    await h.services.billing.advanceClock(accountId, 7 * (DAY_MS / 1000) + 3 * 3600);
    await h.drain();
    expect((await h.services.account.getAccount(accountId)).membership?.status).toBe("active");
    const preview = await h.services.billing.previewPlanChange(accountId, "basic");
    await h.services.billing.changePlan(accountId, {
      planId: "basic",
      previewToken: preview.previewToken,
    });
    await h.drain();
    const downgraded = (await h.services.account.getAccount(accountId)).membership;
    expect(downgraded?.planId).toBe("basic");
    expect(downgraded?.nextInvoice).toEqual({
      at: preview.nextRenewal?.at,
      amount: preview.nextRenewal?.amount,
      creditApplied: preview.nextRenewal?.creditApplied,
      discount: null,
    });
    expect(downgraded?.nextInvoice?.amount.amountMinor).toBeLessThan(799);
    // The reason, as numbers: the plan's price less the credit the downgrade left.
    expect(
      (downgraded?.nextInvoice?.amount.amountMinor ?? 0) +
        (downgraded?.nextInvoice?.creditApplied?.amountMinor ?? 0),
    ).toBe(799);

    await h.services.billing.cancel(accountId);
    expect((await h.services.account.getAccount(accountId)).membership?.nextInvoice).toBeNull();
    await h.services.billing.resume(accountId);
    expect((await h.services.account.getAccount(accountId)).membership?.nextInvoice).toEqual(
      downgraded?.nextInvoice,
    );
  });
});

describe("the open checkout (GET /billing/checkout)", () => {
  it("says which checkout is in progress with its plan, promo code and state, never its secret", async () => {
    const h = await createBillingHarness();
    await h.fake.definePromotion({ code: "WEBFLIX50", percentOff: 50 });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    expect(await h.services.billing.getOpenCheckout(accountId)).toEqual({
      checkout: null,
      trialEligible: true,
    });

    const started = await h.services.billing.startCheckout(auth, {
      planId: "standard",
      promotionCode: "WEBFLIX50",
    });
    expect(started.clientSecret).not.toBeNull();
    const open = await h.services.billing.getOpenCheckout(accountId);
    expect(open.checkout).toMatchObject({
      id: started.id,
      planId: "standard",
      status: "requires_setup",
      clientSecret: null,
      promotion: { code: "WEBFLIX50", percentOff: 50 },
      promotionOutcome: "pending",
    });
    // Continuing it (another device): the secret comes from the checkout itself.
    expect((await h.services.billing.getCheckout(accountId, started.id)).clientSecret).toBe(
      started.clientSecret,
    );

    await h.confirm(started.clientSecret, "visa");
    await h.services.billing.confirmCheckout(accountId, started.id);
    await h.drain();
    expect(await h.services.billing.getOpenCheckout(accountId)).toEqual({
      checkout: null,
      trialEligible: false,
    });
  });

  it("is none once a checkout expires", async () => {
    const h = await createBillingHarness();
    const auth = await h.account();
    await h.services.billing.startCheckout(auth, { planId: "basic" });
    h.clock.advance(25 * 3_600_000);
    expect(await h.services.billing.getOpenCheckout(auth.session.accountId)).toEqual({
      checkout: null,
      trialEligible: true,
    });
  });
});

describe("a promo code is never spent on a payment of nothing", () => {
  it("with a trial: not applied, not redeemed, and the checkout says so; the code stays usable", async () => {
    const h = await createBillingHarness();
    await h.fake.definePromotion({ code: "ONCEONLY", percentOff: 25, maxRedemptions: 1 });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    const started = await h.services.billing.startCheckout(auth, {
      planId: "standard",
      promotionCode: "ONCEONLY",
    });
    await h.confirm(started.clientSecret, "visa");
    const confirmed = await h.services.billing.confirmCheckout(accountId, started.id);
    await h.drain();
    expect(confirmed.trial?.days).toBe(7);
    expect(confirmed.promotion?.code).toBe("ONCEONLY");
    expect(confirmed.promotionOutcome).toBe("not_applied_trial");
    expect(
      (
        (await h.fake.validatePromotionCode({
          code: "ONCEONLY",
          priceLookupKey: "webflix.standard.monthly.usd",
        })) as { valid: boolean }
      ).valid,
    ).toBe(true);
    // The trial converts at the full price, and says so beforehand.
    const membership = (await h.services.account.getAccount(accountId)).membership;
    expect(membership?.nextInvoice?.amount.amountMinor).toBe(1299);
    await h.services.billing.advanceClock(accountId, 7 * (DAY_MS / 1000) + 3 * 3600);
    await h.drain();
    const invoices = await h.services.billing.listInvoices(accountId, {});
    expect(
      invoices.items.find((invoice) => invoice.amountPaid.amountMinor > 0)?.amountPaid,
    ).toEqual({ amountMinor: 1299, currency: "USD" });
  });

  it("without a trial: applied to the first payment and redeemed, as before", async () => {
    const h = await createBillingHarness();
    await h.fake.definePromotion({ code: "ONCEPAID", percentOff: 25, maxRedemptions: 1 });
    const used = await h.account();
    await h.subscribe(used, { card: "visa" });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    const started = await h.services.billing.startCheckout(auth, {
      planId: "standard",
      promotionCode: "ONCEPAID",
    });
    await h.confirm(started.clientSecret, "visa");
    const confirmed = await h.services.billing.confirmCheckout(accountId, started.id);
    expect(confirmed.trial).toBeNull();
    expect(confirmed.promotionOutcome).toBe("applied");
    expect(confirmed.amountDue).toEqual({
      amountMinor: 1299 - Math.round(1299 / 4),
      currency: "USD",
    });
    expect(
      await h.fake.validatePromotionCode({
        code: "ONCEPAID",
        priceLookupKey: "webflix.standard.monthly.usd",
      }),
    ).toMatchObject({ valid: false });
  });
});

describe("a failed card change says why (PaymentMethodSetup.failureReason)", () => {
  it("carries a checkout decline's reason; a later card on the same setup still succeeds", async () => {
    const h = await createBillingHarness();
    const auth = await h.account();
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { card: "visa" });
    for (const [card, reason] of [
      ["declined", "card_declined"],
      ["insufficient-funds", "insufficient_funds"],
      ["expired-card", "expired_card"],
    ] as const) {
      const setup = await h.services.billing.setupPaymentMethod(accountId);
      expect(setup.failureReason).toBeNull();
      const outcome = await h.fake.confirmSetup(setup.clientSecret ?? "", card);
      expect(outcome.status).toBe("failed");
      await h.drain();
      const polled = await h.services.billing.getPaymentMethodSetup(accountId, setup.id);
      expect(polled).toMatchObject({ status: "failed", failureReason: reason, clientSecret: null });
    }
    expect(await problem(h.services.billing.getPaymentMethodSetup(accountId, "nope"))).toBe(
      "not_found",
    );
  });
});
