import type {
  Entitlement,
  MembershipState,
  Money,
  Plan,
  PlanChangePreview,
} from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { describeOutcome, membershipOutcome } from "../src/features/member/billing/outcome.ts";
import {
  describeAppliedPlanChange,
  describePlanChange,
} from "../src/features/member/billing/planChange.ts";

const usd = (amountMinor: number): Money => ({ amountMinor, currency: "USD" });
const PERIOD_END = "2026-12-30T10:00:00.000Z";
const TRIAL_END = "2026-11-30T10:00:00.000Z";
const DELETION = "2026-12-07T10:00:00.000Z";

function view(
  membership: Partial<MembershipState>,
  entitlement: Partial<Entitlement> = {},
): { membership: MembershipState; entitlement: Entitlement } {
  return {
    membership: {
      status: "active",
      planId: "basic",
      cancelAtPeriodEnd: false,
      trialEndsAt: null,
      currentPeriodEnd: PERIOD_END,
      graceEndsAt: null,
      suspendedReason: null,
      provider: "fake",
      nextInvoice: { at: PERIOD_END, amount: usd(799), creditApplied: null, discount: null },
      ...membership,
    },
    entitlement: {
      entitled: true,
      reason: "entitled",
      maxStreams: 1,
      maxVideoHeight: 720,
      until: membership.currentPeriodEnd ?? PERIOD_END,
      ...entitlement,
    } as Entitlement,
  };
}

describe("membershipOutcome: one answer for every screen", () => {
  it("a renewing membership: carries on, next payment at the plan's price", () => {
    const outcome = membershipOutcome(view({}), { monthlyPrice: usd(799) });
    expect(outcome.watchingEnds).toBeNull();
    expect(outcome.nextCharge).toMatchObject({
      amount: usd(799),
      reason: "plan_price",
      kind: "renewal",
    });
    expect(describeOutcome(outcome)).toEqual({
      watching: null,
      charge: "Your next payment is $7.99 on December 30, 2026.",
    });
  });

  it("after a downgrade: the next payment says the credit that lowers it", () => {
    const outcome = membershipOutcome(
      view({
        nextInvoice: { at: PERIOD_END, amount: usd(301), creditApplied: usd(498), discount: null },
      }),
      { monthlyPrice: usd(799) },
    );
    expect(outcome.nextCharge).toMatchObject({ reason: "credit", reducedBy: usd(498) });
    expect(describeOutcome(outcome).charge).toBe(
      "Your $4.98 credit makes your next payment $3.01 on December 30, 2026, then $7.99 a month.",
    );
  });

  it("a code and credit together are both named", () => {
    const outcome = membershipOutcome(
      view({
        nextInvoice: {
          at: PERIOD_END,
          amount: usd(499),
          creditApplied: usd(200),
          discount: usd(100),
        },
      }),
      { monthlyPrice: usd(799) },
    );
    expect(outcome.nextCharge?.reason).toBe("credit_and_discount");
    expect(describeOutcome(outcome).charge).toBe(
      "Your $2.00 credit and $1.00 discount make your next payment $4.99 on December 30, 2026, then $7.99 a month.",
    );
  });

  it("an older API without reasons still never claims the plan's price", () => {
    const outcome = membershipOutcome(view({ nextInvoice: { at: PERIOD_END, amount: usd(301) } }), {
      monthlyPrice: usd(799),
    });
    expect(outcome.nextCharge).toMatchObject({ reason: "reduced", reducedBy: usd(498) });
    expect(describeOutcome(outcome).charge).toBe(
      "Your next payment is $3.01 ($7.99 less $4.98 of credit and discounts) on December 30, 2026, then $7.99 a month.",
    );
  });

  it("a trial: the first payment is when it ends", () => {
    const outcome = membershipOutcome(
      view({
        status: "trialing",
        trialEndsAt: TRIAL_END,
        nextInvoice: { at: TRIAL_END, amount: usd(1299) },
      }),
      { monthlyPrice: usd(1299) },
    );
    expect(describeOutcome(outcome).charge).toBe(
      "Your first payment, $12.99, is on November 30, 2026, when your free trial ends.",
    );
  });

  it("cancelled: watching until the period's end, nothing more charged", () => {
    const outcome = membershipOutcome(view({ cancelAtPeriodEnd: true, nextInvoice: null }));
    expect(outcome).toMatchObject({
      watchingEnds: { at: PERIOD_END, because: "period_ends" },
      nextCharge: null,
      noChargeBecause: "cancelled",
    });
    expect(describeOutcome(outcome)).toEqual({
      watching: "You can watch until December 30, 2026, when your membership ends.",
      charge: "Nothing more is charged.",
    });
  });

  it("a deletion before the period's end: watching continues until the deletion date", () => {
    const outcome = membershipOutcome(view({ cancelAtPeriodEnd: true, nextInvoice: null }), {
      deletion: { scheduledFor: DELETION },
    });
    expect(outcome).toMatchObject({
      watching: true,
      watchingEnds: { at: DELETION, because: "account_deleted" },
      nextCharge: null,
      noChargeBecause: "deletion",
    });
    expect(describeOutcome(outcome).watching).toBe(
      "You can watch until December 7, 2026, when your account is deleted.",
    );
  });

  it("a deletion after a trial's end: the trial ends first, and is not converted", () => {
    const outcome = membershipOutcome(
      view({
        status: "trialing",
        trialEndsAt: TRIAL_END,
        nextInvoice: null,
        cancelAtPeriodEnd: true,
      }),
      { deletion: { scheduledFor: DELETION } },
    );
    expect(outcome.watchingEnds).toEqual({ at: TRIAL_END, because: "trial_ends" });
    expect(outcome.nextCharge).toBeNull();
  });

  it("the deletion request's own end date wins when it gives one", () => {
    const outcome = membershipOutcome(view({ cancelAtPeriodEnd: true, nextInvoice: null }), {
      deletion: {
        scheduledFor: DELETION,
        membership: { status: "ending", endsAt: DELETION, resumable: false },
      },
    });
    expect(outcome.watchingEnds).toEqual({ at: DELETION, because: "account_deleted" });
  });

  it("past due: watching until grace ends, nothing new scheduled", () => {
    const grace = "2026-12-05T10:00:00.000Z";
    const outcome = membershipOutcome(
      view(
        { status: "past_due", graceEndsAt: grace, nextInvoice: null },
        { reason: "entitled", until: grace },
      ),
    );
    expect(outcome).toMatchObject({
      watchingEnds: { at: grace, because: "grace_ends" },
      nextCharge: null,
      noChargeBecause: "payment_due",
    });
  });

  it("milestone 1's built-in membership is never charged and ends with the account", () => {
    const outcome = membershipOutcome(view({ provider: null, nextInvoice: null }), {
      deletion: { scheduledFor: DELETION },
    });
    expect(outcome).toMatchObject({
      watchingEnds: { at: DELETION, because: "account_deleted" },
      nextCharge: null,
      noChargeBecause: "built_in",
    });
  });

  it("no membership, ended, on hold: nothing to watch, nothing scheduled", () => {
    for (const status of ["none", "canceled", "suspended", "incomplete"] as const) {
      const outcome = membershipOutcome(view({ status, nextInvoice: null }, { entitled: false }));
      expect(outcome.watching).toBe(false);
      expect(outcome.nextCharge).toBeNull();
    }
  });
});

describe("describePlanChange: today and next, each with its reason", () => {
  const plan = (id: "basic" | "standard" | "premium", name: string, price: number) =>
    ({
      id,
      name,
      monthlyPrice: usd(price),
      maxStreams: 1,
      maxVideoHeight: 720,
      highlighted: false,
      trial: null,
    }) as unknown as Plan;
  const standard = plan("standard", "Standard", 1299);
  const basic = plan("basic", "Basic", 799);
  const premium = plan("premium", "Premium", 1899);
  const preview = (over: Partial<PlanChangePreview>): PlanChangePreview => ({
    planId: "basic",
    amountDue: usd(0),
    creditApplied: null,
    discount: null,
    credit: usd(0),
    lines: [],
    effectiveAt: "2026-11-30T10:00:00.000Z",
    nextRenewal: null,
    previewToken: "t",
    expiresAt: "2026-11-30T10:10:00.000Z",
    ...over,
  });

  it("a downgrade: nothing today, the credit left over, and what it does to the next payment", () => {
    const wording = describePlanChange(
      preview({
        credit: usd(498),
        nextRenewal: { at: PERIOD_END, amount: usd(301), creditApplied: usd(498), discount: null },
      }),
      { current: standard, next: basic, trialing: false },
    );
    expect(wording.today).toBe(
      "Nothing to pay today. The time left on Standard covers Basic until your next payment, with $4.98 left over as credit.",
    );
    expect(wording.next).toBe(
      "Your $4.98 credit makes your next payment $3.01 on December 30, 2026, then $7.99 a month.",
    );
  });

  it("an upgrade: what is paid today, and why it is less than the new plan's time", () => {
    const wording = describePlanChange(
      preview({
        planId: "premium",
        amountDue: usd(594),
        creditApplied: usd(1295),
        nextRenewal: { at: PERIOD_END, amount: usd(1899), creditApplied: null, discount: null },
      }),
      { current: standard, next: premium, trialing: false },
    );
    expect(wording.today).toBe(
      "You pay $5.94 today: $18.89 for the rest of this billing period on Premium, less your $12.95 credit for the time left on Standard.",
    );
    expect(wording.next).toBe("Your next payment is $18.99 on December 30, 2026.");
    expect(
      describeAppliedPlanChange(
        preview({ planId: "premium", amountDue: usd(594), creditApplied: usd(1295) }),
        { current: standard, next: premium, trialing: false },
      ),
    ).toBe("$5.94 was charged today.");
  });

  it("during a trial: nothing today, the first payment at the new price", () => {
    const wording = describePlanChange(
      preview({ nextRenewal: { at: TRIAL_END, amount: usd(799) } }),
      { current: standard, next: basic, trialing: true },
    );
    expect(wording.today).toBe("Nothing to pay today: your free trial carries on with Basic.");
    expect(wording.next).toBe(
      "Your first payment, $7.99, is on November 30, 2026, when your free trial ends.",
    );
  });
});
