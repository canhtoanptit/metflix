import { describe, expect, it } from "vitest";
import { createBillingHarness, DAY_MS } from "./harness.ts";

/**
 * UX review 2.6, 2.3 and 2.2: whether an account can still have a trial, known before any card;
 * and every amount that can differ from the plan's price says why, as numbers (the credit it
 * uses and its discount), so the web says one sentence: "$3.01 ($7.99 less your $4.98 credit)".
 */

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

describe("trial eligibility, before any card (OpenCheckout.trialEligible)", () => {
  it("is true for a new account, false once it had a trial; a card's own trial is found at confirmation", async () => {
    const h = await createBillingHarness();
    const first = await h.account();
    expect((await h.services.billing.getOpenCheckout(first.session.accountId)).trialEligible).toBe(
      true,
    );
    await h.subscribe(first, { plan: "basic", card: "visa:shared-card" });
    expect((await h.services.billing.getOpenCheckout(first.session.accountId)).trialEligible).toBe(
      false,
    );

    // A second account never had a trial, so it is told it may; the card it brings had one.
    const second = await h.account();
    const accountId = second.session.accountId;
    expect((await h.services.billing.getOpenCheckout(accountId)).trialEligible).toBe(true);
    const started = await h.services.billing.startCheckout(second, { planId: "basic" });
    // Eligible: nothing is estimated before the card (the trial is the likely outcome).
    expect(started.amountDue).toBeNull();
    await h.confirm(started.clientSecret, "visa:shared-card");
    const confirmed = await h.services.billing.confirmCheckout(accountId, started.id);
    expect(confirmed).toMatchObject({ status: "requires_payment", trial: null });
    expect(confirmed.amountDue).toEqual(usd(799));
  });
});

describe("amounts with their reason", () => {
  it("a plan-change preview: the new plan's remaining time less the old plan's unused time", async () => {
    const h = await createBillingHarness();
    const auth = await h.account();
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { plan: "standard", card: "visa" });
    await h.services.billing.advanceClock(accountId, 7 * (DAY_MS / 1000) + 3 * 3600);
    await h.drain();
    const upgrade = await h.services.billing.previewPlanChange(accountId, "premium");
    const remaining = upgrade.lines
      .map((line) => line.amount.amountMinor)
      .filter((amount) => amount > 0)
      .reduce((sum, amount) => sum + amount, 0);
    const unused = -upgrade.lines
      .map((line) => line.amount.amountMinor)
      .filter((amount) => amount < 0)
      .reduce((sum, amount) => sum + amount, 0);
    expect(upgrade.amountDue.amountMinor).toBeGreaterThan(0);
    expect(upgrade.creditApplied).toEqual(usd(unused));
    expect(upgrade.discount).toBeNull();
    expect(upgrade.amountDue.amountMinor + unused).toBe(remaining);

    const downgrade = await h.services.billing.previewPlanChange(accountId, "basic");
    expect(downgrade.amountDue).toEqual(usd(0));
    // Basic's remaining time is all paid by Standard's unused time; the rest is credit kept,
    // which the first renewal on Basic uses.
    expect(downgrade.credit.amountMinor).toBeGreaterThan(0);
    expect(downgrade.nextRenewal).toMatchObject({
      amount: usd(799 - downgrade.credit.amountMinor),
      creditApplied: usd(downgrade.credit.amountMinor),
      discount: null,
    });
  });

  it("after a downgrade: the credit is a credit in billing history, and the next payment says it uses it", async () => {
    const h = await createBillingHarness();
    const auth = await h.account();
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { plan: "standard", card: "visa" });
    await h.services.billing.advanceClock(accountId, 7 * (DAY_MS / 1000) + 3 * 3600);
    await h.drain();
    const preview = await h.services.billing.previewPlanChange(accountId, "basic");
    await h.services.billing.changePlan(accountId, {
      planId: "basic",
      previewToken: preview.previewToken,
    });
    await h.drain();
    const credit = preview.credit.amountMinor;
    const next = (await h.services.account.getAccount(accountId)).membership?.nextInvoice;
    expect(next).toMatchObject({
      amount: usd(799 - credit),
      creditApplied: usd(credit),
      discount: null,
    });

    const history = await h.services.billing.listInvoices(accountId, {});
    const change = history.items.find((invoice) => invoice.description === "Plan change");
    // A credit, not a payment: a negative total, nothing paid.
    expect(change?.total.amountMinor).toBe(-credit);
    expect(change?.amountPaid).toEqual(usd(0));

    // The renewal uses it, and says so.
    await h.services.billing.advanceClock(accountId, 31 * (DAY_MS / 1000));
    await h.drain();
    const renewal = (await h.services.billing.listInvoices(accountId, {})).items.find(
      (invoice) => invoice.description === "Membership renewal",
    );
    expect(renewal).toMatchObject({
      total: usd(799),
      amountPaid: usd(799 - credit),
      creditApplied: usd(credit),
      discount: null,
    });
  });

  it("a restart: what it charges and why is known before the card, and the payment matches it", async () => {
    const h = await createBillingHarness();
    await h.fake.definePromotion({ code: "COMEBACK", amountOffMinor: 100 });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { plan: "standard", card: "visa" });
    await h.services.billing.advanceClock(accountId, 7 * (DAY_MS / 1000) + 3 * 3600);
    await h.drain();
    const preview = await h.services.billing.previewPlanChange(accountId, "basic");
    await h.services.billing.changePlan(accountId, {
      planId: "basic",
      previewToken: preview.previewToken,
    });
    const credit = preview.credit.amountMinor;
    // Cancelled before the renewal could use the credit; the membership ends.
    await h.services.billing.cancel(accountId);
    await h.services.billing.advanceClock(accountId, 31 * (DAY_MS / 1000));
    await h.drain();
    expect((await h.services.account.getAccount(accountId)).membership?.status).toBe("canceled");

    expect((await h.services.billing.getOpenCheckout(accountId)).trialEligible).toBe(false);
    const started = await h.services.billing.startCheckout(auth, {
      planId: "basic",
      promotionCode: "COMEBACK",
    });
    // Before the provider's form: $7.99 less $1.00 off, less the credit.
    expect(started).toMatchObject({
      status: "requires_setup",
      amountDue: usd(799 - 100 - credit),
      creditApplied: usd(credit),
      discount: usd(100),
    });
    // Another plan on the same checkout: estimated again.
    const switched = await h.services.billing.startCheckout(auth, { planId: "standard" });
    expect(switched).toMatchObject({
      id: started.id,
      amountDue: usd(1299 - credit),
      creditApplied: usd(credit),
      discount: null,
    });
    await h.confirm(switched.clientSecret, "visa");
    const confirmed = await h.services.billing.confirmCheckout(accountId, started.id);
    expect(confirmed).toMatchObject({
      status: "requires_payment",
      amountDue: usd(1299 - credit),
      creditApplied: usd(credit),
      discount: null,
    });
  });
});
