import type { MemoryEmailSender } from "@webflix/core/memory";
import { describe, expect, it } from "vitest";
import { createBillingHarness, DAY_MS } from "./harness.ts";

const DAY_SEC = DAY_MS / 1000;

describe("billing's seams with the other areas", () => {
  it("emails a receipt, a failed payment, a cancellation and the end of a trial, each once", async () => {
    const h = await createBillingHarness();
    const mailbox = h.deps.email as MemoryEmailSender;
    const auth = await h.account("mail@example.test");
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { card: "charge-declined" });
    // Trial ending: three days before the trial's end, from the trial's own end time.
    await h.services.billing.advanceClock(accountId, 4 * DAY_SEC + 3600);
    await h.services.billing.reconcile();
    await h.services.billing.reconcile();
    await h.drain();
    // The renewal declines: payment failed.
    await h.services.billing.advanceClock(accountId, 3 * DAY_SEC + 3600);
    await h.drain();
    const setup = await h.services.billing.setupPaymentMethod(accountId);
    await h.confirm(setup.clientSecret, "visa");
    await h.drain();
    await h.services.billing.cancel(accountId);
    await h.drain();
    // A redelivery and a reconciliation send nothing new.
    await h.services.billing.reconcile();
    await h.drain();
    const templates = mailbox.mailbox("mail@example.test").map((message) => message.template);
    expect(templates.filter((template) => template === "trial-ending")).toHaveLength(1);
    expect(templates.filter((template) => template === "payment-failed")).toHaveLength(1);
    expect(templates.filter((template) => template === "receipt")).toHaveLength(1);
    expect(templates.filter((template) => template === "cancellation")).toHaveLength(1);
  });

  it("gives the session its membership: none for a new account, trialing after checkout", async () => {
    const h = await createBillingHarness();
    const auth = await h.account();
    const before = await h.services.auth.sessionState(auth);
    expect(before.membership).toMatchObject({ status: "none" });
    expect(before.entitlement?.entitled).toBe(false);
    expect(before).toMatchObject({ subscription: null, plan: null });
    await h.subscribe(auth);
    const after = await h.services.auth.sessionState(auth);
    expect(after.membership).toMatchObject({ status: "trialing", planId: "standard" });
    expect(after.subscription).toMatchObject({ planId: "standard", status: "active" });
    expect(after.plan?.id).toBe("standard");
  });

  it("tells other areas the plan held now and staff each member's status", async () => {
    const h = await createBillingHarness();
    const member = await h.account();
    const nobody = await h.account();
    await h.subscribe(member, { plan: "premium" });
    expect(await h.services.billing.currentPlan(member.session.accountId)).toBe("premium");
    expect(await h.services.billing.currentPlan(nobody.session.accountId)).toBeNull();
    const summaries = await h.services.billing.membershipSummaries([
      member.session.accountId,
      nobody.session.accountId,
      "acct-unknown",
    ]);
    expect(summaries.get(member.session.accountId)).toEqual({
      membershipStatus: "trialing",
      planId: "premium",
    });
    expect(summaries.get(nobody.session.accountId)).toEqual({
      membershipStatus: "none",
      planId: null,
    });
    expect(summaries.has("acct-unknown")).toBe(false);
  });

  it("exports every checkout with its promo code and what became of it, and every card change; never a secret", async () => {
    const h = await createBillingHarness();
    await h.fake.definePromotion({ code: "WEBFLIX50", percentOff: 50 });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    const started = await h.services.billing.startCheckout(auth, {
      planId: "standard",
      promotionCode: "WEBFLIX50",
    });
    await h.confirm(started.clientSecret, "visa");
    await h.services.billing.confirmCheckout(accountId, started.id);
    await h.drain();
    const setup = await h.services.billing.setupPaymentMethod(accountId);
    const exported = (await h.services.billing.exportAccountData?.(accountId)) as {
      checkouts: { id: string; planId: string; status: string; clientSecret: null }[];
      promotionCodes: { code: string; checkoutId: string; outcome: string }[];
      cardChanges: { id: string; status: string; clientSecret: null }[];
    };
    expect(exported.checkouts).toEqual([
      expect.objectContaining({
        id: started.id,
        planId: "standard",
        status: "complete",
        clientSecret: null,
      }),
    ]);
    expect(exported.promotionCodes).toEqual([
      expect.objectContaining({
        code: "WEBFLIX50",
        checkoutId: started.id,
        outcome: "not_applied_trial",
      }),
    ]);
    expect(exported.cardChanges).toEqual([
      expect.objectContaining({
        id: setup.id,
        status: "requires_confirmation",
        clientSecret: null,
      }),
    ]);
    expect(JSON.stringify(exported)).not.toContain("_secret_");
  });

  it("exports the membership and invoices, and on erasure deletes the customer at the provider but keeps the invoices", async () => {
    const h = await createBillingHarness();
    const used = await h.account();
    await h.subscribe(used, { card: "visa" });
    const auth = await h.account();
    const accountId = auth.session.accountId;
    await h.subscribe(auth, { plan: "basic" });
    const exported = (await h.services.billing.exportAccountData?.(accountId)) as {
      membership: { status: string; planId: string };
      invoices: { amountPaid: { amountMinor: number } }[];
    };
    expect(exported.membership).toMatchObject({ status: "active", planId: "basic" });
    expect(exported.invoices.some((invoice) => invoice.amountPaid.amountMinor === 799)).toBe(true);

    const record = await h.repos.billing.getMembership(accountId);
    await h.services.billing.eraseAccountData?.(accountId);
    await h.services.billing.eraseAccountData?.(accountId);
    expect((await h.fake.retrieveSubscription(record?.providerSubscriptionId ?? ""))?.status).toBe(
      "canceled",
    );
    // Billing's own records of the account: only the financial ones are left.
    expect(await h.repos.billing.getMembership(accountId)).toBeNull();
    expect(await h.repos.billing.getCustomer(accountId, "fake")).toBeNull();
    expect(await h.repos.billing.hasTrialFingerprint(accountId)).toBe(false);
    const invoices = await h.repos.billing.listInvoices(accountId, { limit: 10, before: null });
    expect(invoices.length).toBeGreaterThan(0);
    expect((await h.fake.retrieveInvoice(invoices[0]?.providerInvoiceId ?? ""))?.status).toBe(
      "paid",
    );
  });
});
