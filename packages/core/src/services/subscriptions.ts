import type { Plan, SubscriptionStatus } from "@webflix/contracts";
import { readMembership } from "../areas/billing/membership.ts";
import { getPlan } from "../domain/plans.ts";
import { AppError } from "../errors.ts";
import type { AccountRecord, SubscriptionRecord } from "../repositories/records.ts";
import type { ServiceDependencies } from "./context.ts";

/** Milestone 1's mock periods are 30 days (the seeded demo account's membership). */
export const BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Status is derived from the record and the clock, never stored, so no job has to flip
 * memberships at period boundaries:
 * - not canceled: `active`; the period renews automatically (the mock provider always
 *   collects), so the effective period end rolls forward past `now`;
 * - canceled: `canceling` until the period end, then `ended`.
 */
export function effectiveSubscription(
  subscription: SubscriptionRecord,
  now: number,
): { status: SubscriptionStatus; currentPeriodEnd: number } {
  if (subscription.canceledAt === null) {
    let end = subscription.currentPeriodEnd;
    if (end <= now) end += Math.ceil((now - end + 1) / BILLING_PERIOD_MS) * BILLING_PERIOD_MS;
    return { status: "active", currentPeriodEnd: end };
  }
  return {
    status: now < subscription.currentPeriodEnd ? "canceling" : "ended",
    currentPeriodEnd: subscription.currentPeriodEnd,
  };
}

/**
 * Whether the account may start playing now, and on which plan (its streams and quality cap):
 * the one entitlement decision playback asks for (§5.2). Owned by billing: it reads the
 * membership projection when the account has a provider membership (trial, grace and
 * suspension included), else milestone 1's mock membership (the seeded demo account's); an
 * account without either has no membership. One read of `memberships` per playback start.
 */
export async function playbackEntitlement(
  deps: Pick<ServiceDependencies, "repos" | "config">,
  account: { account: AccountRecord; subscription: SubscriptionRecord | null },
  now: number,
): Promise<Plan> {
  const snapshot = await readMembership(deps, account.account.id, account.subscription, now);
  if (!snapshot.entitlement.entitled || snapshot.effective.planId === null) {
    throw new AppError("subscription_required", {
      subscriptionStatus: snapshot.legacy?.subscription.status ?? "ended",
      membershipStatus: snapshot.state.status,
    });
  }
  return getPlan(snapshot.effective.planId);
}
