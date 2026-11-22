import { AppError } from "@webflix/core";
import { describe, expect, it } from "vitest";
import type { FakeCardChoice } from "../../src/cards.ts";
import { createBillingHarness, DAY_MS } from "./harness.ts";

async function problem(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "expected an AppError").toBeInstanceOf(AppError);
  return (error as AppError).code;
}

/** A second account whose checkout stops at its first payment (its card already had a trial). */
async function firstPaymentPending(h: Awaited<ReturnType<typeof createBillingHarness>>) {
  const used = await h.account();
  await h.subscribe(used, { card: "visa" });
  const auth = await h.account();
  const started = await h.services.billing.startCheckout(auth, { planId: "basic" });
  await h.confirm(started.clientSecret, "visa");
  const confirmed = await h.services.billing.confirmCheckout(auth.session.accountId, started.id);
  expect(confirmed.status).toBe("requires_payment");
  await h.drain();
  return { auth, accountId: auth.session.accountId, checkoutId: started.id };
}

describe("billing fix round", () => {
  it("M2-F3: a first payment abandoned for another plan leaves no membership, not an ended one", async () => {
    const h = await createBillingHarness();
    const { auth, accountId, checkoutId } = await firstPaymentPending(h);
    const second = await h.services.billing.startCheckout(auth, { planId: "standard" });
    expect(second.status).toBe("requires_setup");
    await h.drain();
    expect((await h.services.billing.getCheckout(accountId, checkoutId)).status).toBe("expired");
    const account = await h.services.account.getAccount(accountId);
    expect(account.membership).toEqual({
      status: "none",
      planId: null,
      cancelAtPeriodEnd: false,
      trialEndsAt: null,
      currentPeriodEnd: null,
      graceEndsAt: null,
      suspendedReason: null,
      provider: null,
    });
    expect(account.entitlement).toMatchObject({ entitled: false, reason: "no_membership" });
    expect(account.subscription).toMatchObject({ status: "ended", planId: "basic" });
    expect(account.paymentMethod).toBeNull();
    // Replayed from the provider's own state (a reconciliation), the answer is the same.
    await h.services.billing.syncAccount(accountId);
    expect((await h.services.account.getAccount(accountId)).membership?.status).toBe("none");
  });

  it("M2-F4: an expired first payment is none with no plan, provider or period", async () => {
    const h = await createBillingHarness();
    const { accountId, checkoutId } = await firstPaymentPending(h);
    await h.services.billing.advanceClock(accountId, 24 * 3600);
    await h.drain();
    const account = await h.services.account.getAccount(accountId);
    expect(account.membership).toMatchObject({
      status: "none",
      planId: null,
      provider: null,
      currentPeriodEnd: null,
      trialEndsAt: null,
    });
    expect(account.entitlement?.reason).toBe("no_membership");
    expect((await h.services.billing.getCheckout(accountId, checkoutId)).status).toBe("expired");
    const session = await h.services.auth.sessionState({
      session:
        (await h.repos.sessions.listForAccount(accountId, h.clock.now()))[0] ??
        (() => {
          throw new Error("no session");
        })(),
      profile: null,
    });
    expect(session.membership?.status).toBe("none");
  });

  it("M2-F3 does not touch a trial cancelled before its end: that member had a membership", async () => {
    const h = await createBillingHarness();
    const auth = await h.account();
    await h.subscribe(auth, { card: "visa" });
    const record = await h.repos.billing.getMembership(auth.session.accountId);
    await h.fake.cancelNow(
      { subscriptionId: record?.providerSubscriptionId ?? "" },
      { idempotencyKey: "fix-cancel-trial" },
    );
    await h.drain();
    const account = await h.services.account.getAccount(auth.session.accountId);
    expect(account.membership?.status).toBe("canceled");
    expect(account.entitlement?.reason).toBe("ended");
  });

  it("M2-F1: a standing promo code is always there, for every plan, however often it is used", async () => {
    const h = await createBillingHarness({
      fake: { promotions: [{ code: "WEBFLIX50", percentOff: 50 }] },
    });
    for (let i = 0; i < 3; i += 1) {
      const quote = await h.services.billing.validatePromotion({
        code: "webflix50",
        planId: "standard",
      });
      expect(quote.discountedPrice.amountMinor).toBe(1299 - Math.round(1299 / 2));
      const auth = await h.account();
      const started = await h.services.billing.startCheckout(auth, {
        planId: "standard",
        promotionCode: "WEBFLIX50",
      });
      expect(started.promotion?.code).toBe("WEBFLIX50");
      await h.confirm(started.clientSecret, `visa:promo-${i}`);
      const confirmed = await h.services.billing.confirmCheckout(
        auth.session.accountId,
        started.id,
      );
      expect(confirmed.trial).not.toBeNull();
    }
    // Paid at once (no trial left on the card): charged the discounted price.
    const used = await h.account();
    await h.subscribe(used, { card: "mastercard" });
    const paid = await h.account();
    const started = await h.services.billing.startCheckout(paid, {
      planId: "standard",
      promotionCode: "WEBFLIX50",
    });
    await h.confirm(started.clientSecret, "mastercard");
    const confirmed = await h.services.billing.confirmCheckout(paid.session.accountId, started.id);
    expect(confirmed.amountDue).toEqual({
      amountMinor: 1299 - Math.round(1299 / 2),
      currency: "USD",
    });
  });

  it("M2-F2: a labelled card is a fresh card (its own trial); the same label again earns none", async () => {
    const h = await createBillingHarness();
    const trialWith = async (card: FakeCardChoice) => {
      const auth = await h.account();
      const started = await h.services.billing.startCheckout(auth, { planId: "basic" });
      await h.confirm(started.clientSecret, card);
      return (await h.services.billing.confirmCheckout(auth.session.accountId, started.id)).trial;
    };
    expect(await trialWith("visa")).not.toBeNull();
    expect(await trialWith("visa")).toBeNull();
    expect(await trialWith("visa:run-1")).not.toBeNull();
    expect(await trialWith("visa:run-1")).toBeNull();
    expect(await trialWith("visa:run-2")).not.toBeNull();
    // It behaves like its test card: a labelled declining card still declines.
    const auth = await h.account();
    const started = await h.services.billing.startCheckout(auth, { planId: "basic" });
    expect(await h.fake.confirmSetup(started.clientSecret ?? "", "declined:run-1")).toEqual({
      status: "failed",
      code: "card_declined",
    });
    expect(
      await problem(h.services.billing.confirmCheckout(auth.session.accountId, started.id)),
    ).toBe("payment_declined");
  });

  it("exports what the account page shows, for a milestone 1 member too", async () => {
    const h = await createBillingHarness();
    const auth = await h.account();
    const accountId = auth.session.accountId;
    // A milestone 1 member: the mock membership row with its card.
    await h.repos.accounts.saveSubscription({
      accountId,
      planId: "premium",
      startedAt: h.clock.now() - 10 * DAY_MS,
      currentPeriodEnd: h.clock.now() + 20 * DAY_MS,
      canceledAt: null,
      card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2031 },
      updatedAt: h.clock.now(),
    });
    const exported = (await h.services.billing.exportAccountData?.(accountId)) as Record<
      string,
      unknown
    >;
    expect(exported.membership).toMatchObject({
      status: "active",
      planId: "premium",
      provider: null,
    });
    expect(exported.subscription).toMatchObject({ planId: "premium", status: "active" });
    expect(exported.plan).toMatchObject({ id: "premium", name: "Premium" });
    expect(exported.paymentMethod).toEqual({
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2031,
    });
    expect(exported.entitlement).toMatchObject({ entitled: true });
  });

  it("staff cancel now with a refund returns the refund with the membership", async () => {
    const h = await createBillingHarness();
    const used = await h.account();
    await h.subscribe(used, { card: "visa" });
    const auth = await h.account();
    await h.subscribe(auth, { plan: "standard", card: "visa" });
    h.clock.advance(10 * DAY_MS);
    const result = await h.services.billing.cancelForStaff({
      accountId: auth.session.accountId,
      when: "now",
      refundUnused: true,
      reason: "goodwill",
      staffSubject: "staff-1",
    });
    expect(result.membership.status).toBe("canceled");
    expect(result.refund?.status).toBe("succeeded");
    expect(result.refund?.amount.amountMinor).toBeGreaterThan(0);
    expect(result.refund?.amount.amountMinor).toBeLessThan(1299);
    const atPeriodEnd = await h.services.billing.cancelForStaff({
      accountId: used.session.accountId,
      when: "period_end",
      reason: "asked",
      staffSubject: "staff-1",
    });
    expect(atPeriodEnd.refund).toBeNull();
    expect(atPeriodEnd.membership.cancelAtPeriodEnd).toBe(true);
  });
});
