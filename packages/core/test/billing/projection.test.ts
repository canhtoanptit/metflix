import { describe, expect, it } from "vitest";
import {
  effectiveMembership,
  entitlementOf,
  legacyMembership,
  planFromLookupKey,
  projectMembership,
  supersedes,
} from "../../src/areas/billing/projection.ts";
import type {
  ProviderSubscription,
  ProviderSubscriptionStatus,
} from "../../src/ports/payment-provider.ts";
import { makeMembershipRecord } from "../../src/testing/areas/billing.contract.ts";
import { makeSubscriptionRecord } from "../../src/testing/records.ts";

const NOW = Date.UTC(2026, 10, 22, 12);
const DAY = 24 * 3_600_000;
const GRACE_SEC = 7 * 24 * 3600;

function subscription(overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return {
    id: "sub_1",
    customerId: "cus_1",
    status: "active",
    priceLookupKey: "webflix.standard.monthly.usd",
    cancelAtPeriodEnd: false,
    trialEnd: null,
    currentPeriodStart: NOW - DAY,
    currentPeriodEnd: NOW + 29 * DAY,
    endedAt: null,
    latestInvoiceId: "in_1",
    defaultPaymentMethodId: "pm_1",
    defaultPaymentMethod: {
      id: "pm_1",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      fingerprint: "fp",
      wallet: null,
    },
    paymentClientSecret: null,
    clockNow: null,
    ...overrides,
  };
}

const project = (
  sub: ProviderSubscription,
  firstFailureAt: number | null = null,
  previous = null,
) =>
  projectMembership({
    previous,
    accountId: "acc-1",
    provider: "fake",
    subscription: sub,
    firstFailureAt,
    now: NOW,
  });

describe("the membership state machine (§5.2, docs/STRIPE.md §9)", () => {
  it.each<[ProviderSubscriptionStatus, string, string | null, boolean, string]>([
    ["incomplete", "incomplete", null, false, "payment_pending"],
    ["incomplete_expired", "none", null, false, "no_membership"],
    ["trialing", "trialing", null, true, "entitled"],
    ["active", "active", null, true, "entitled"],
    ["past_due", "past_due", null, true, "entitled"],
    ["unpaid", "suspended", "unpaid", false, "suspended"],
    ["paused", "suspended", "paused", false, "suspended"],
    ["canceled", "canceled", null, false, "ended"],
  ])("provider %s → %s", (status, stored, reason, entitled, entitlementReason) => {
    const record = project(
      subscription({ status, trialEnd: status === "trialing" ? NOW + DAY : null }),
      NOW,
    );
    expect(record.status).toBe(stored);
    expect(record.suspendedReason).toBe(reason);
    const effective = effectiveMembership(record, GRACE_SEC, NOW);
    expect(entitlementOf(effective)).toMatchObject({ entitled, reason: entitlementReason });
  });

  it("starts grace at the first failed attempt, keeps it across retries, and suspends by time", () => {
    const failedAt = NOW - 2 * DAY;
    const first = project(subscription({ status: "past_due" }), failedAt);
    expect(first.graceStartedAt).toBe(failedAt);
    // A retry's failure (later) never moves it; the earliest known failure wins.
    const retried = projectMembership({
      previous: first,
      accountId: "acc-1",
      provider: "fake",
      subscription: subscription({ status: "past_due" }),
      firstFailureAt: failedAt,
      now: NOW + DAY,
    });
    expect(retried.graceStartedAt).toBe(failedAt);
    expect(effectiveMembership(retried, GRACE_SEC, NOW).status).toBe("past_due");
    const expired = effectiveMembership(retried, GRACE_SEC, failedAt + GRACE_SEC * 1000);
    expect(expired).toMatchObject({ status: "suspended", suspendedReason: "grace_expired" });
    expect(entitlementOf(expired)).toMatchObject({ entitled: false, reason: "suspended" });
    // Before any failure event is known (reconciliation first): grace from now, until it is.
    const observed = project(subscription({ status: "past_due" }), null);
    expect(observed.graceStartedAt).toBe(NOW);
    const corrected = projectMembership({
      previous: observed,
      accountId: "acc-1",
      provider: "fake",
      subscription: subscription({ status: "past_due" }),
      firstFailureAt: failedAt,
      now: NOW + 60_000,
    });
    expect(corrected.graceStartedAt).toBe(failedAt);
  });

  it("starts a new grace for a new overdue invoice, not an old one's", () => {
    const old = project(
      subscription({ status: "past_due", latestInvoiceId: "in_old" }),
      NOW - 40 * DAY,
    );
    const next = projectMembership({
      previous: old,
      accountId: "acc-1",
      provider: "fake",
      subscription: subscription({ status: "past_due", latestInvoiceId: "in_new" }),
      firstFailureAt: NOW - DAY,
      now: NOW,
    });
    expect(next.graceStartedAt).toBe(NOW - DAY);
    expect(next.graceInvoiceId).toBe("in_new");
  });

  it("keeps a cancelled membership entitled until the period end, then ends it by time", () => {
    const record = project(subscription({ cancelAtPeriodEnd: true }));
    const now = effectiveMembership(record, GRACE_SEC, NOW);
    expect(now).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    expect(entitlementOf(now).until).toBe(new Date(NOW + 29 * DAY).toISOString());
    const after = effectiveMembership(record, GRACE_SEC, NOW + 30 * DAY);
    expect(after.status).toBe("canceled");
    expect(entitlementOf(after).entitled).toBe(false);
  });

  it("judges time in the provider's clock (a test clock ahead of ours)", () => {
    const record = project(
      subscription({ status: "past_due", clockNow: NOW + 10 * DAY }),
      NOW + 2 * DAY,
    );
    expect(record.clockOffsetMs).toBe(10 * DAY);
    // Our clock says 2 days of grace used, the provider's says 8: suspended.
    expect(effectiveMembership(record, GRACE_SEC, NOW).status).toBe("suspended");
  });

  it("never lets an ended old subscription overwrite a newer live one", () => {
    const live = makeMembershipRecord({ providerSubscriptionId: "sub_new", status: "active" });
    expect(supersedes(live, subscription({ id: "sub_old", status: "canceled" }))).toBe(false);
    expect(supersedes(live, subscription({ id: "sub_new", status: "canceled" }))).toBe(true);
    const ended = makeMembershipRecord({ providerSubscriptionId: "sub_old", status: "canceled" });
    expect(supersedes(ended, subscription({ id: "sub_new", status: "trialing" }))).toBe(true);
    expect(supersedes(null, subscription())).toBe(true);
  });

  it("reads milestone 1's mock membership through the same states", () => {
    const active = legacyMembership(makeSubscriptionRecord({ currentPeriodEnd: NOW + DAY }), NOW);
    expect(active).toMatchObject({ status: "active", planId: "standard", provider: null });
    const canceling = legacyMembership(
      makeSubscriptionRecord({ currentPeriodEnd: NOW + DAY, canceledAt: NOW - DAY }),
      NOW,
    );
    expect(canceling).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    const ended = legacyMembership(
      makeSubscriptionRecord({ currentPeriodEnd: NOW - DAY, canceledAt: NOW - 2 * DAY }),
      NOW,
    );
    expect(entitlementOf(ended)).toMatchObject({ entitled: false, reason: "ended" });
    // An account created without payment has no membership, whatever its placeholder says.
    const none = legacyMembership(makeSubscriptionRecord({ card: null, canceledAt: null }), NOW);
    expect(entitlementOf(none)).toMatchObject({ entitled: false, reason: "no_membership" });
    expect(entitlementOf(legacyMembership(null, NOW)).reason).toBe("no_membership");
  });

  it("only accepts Webflix's own lookup keys as plans", () => {
    expect(planFromLookupKey("webflix.premium.monthly.eur")).toBe("premium");
    expect(planFromLookupKey("webflix.gold.monthly.usd")).toBeNull();
    expect(planFromLookupKey("price_123")).toBeNull();
  });
});
