import type { AccountDetails, Entitlement, Membership, MembershipState } from "@webflix/contracts";
import { getPlan } from "../../domain/plans.ts";
import type { AccountRecord, SubscriptionRecord } from "../../repositories/records.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import {
  presentAccount,
  presentPaymentMethod,
  presentSubscription,
} from "../../services/presenters.ts";
import {
  type EffectiveMembership,
  effectiveMembership,
  entitlementOf,
  legacyMembership,
  legacySubscriptionView,
  presentMembershipState,
} from "./projection.ts";
import type { MembershipRecord } from "./repository.ts";

/**
 * One account's membership, read once: the provider projection when the account has one, else
 * milestone 1's mock membership (`subscriptions`), else none. Everything that asks "may this
 * account play, and on what plan?" (playback, the account page, the staff console) reads this.
 */
export interface MembershipSnapshot {
  record: MembershipRecord | null;
  effective: EffectiveMembership;
  entitlement: Entitlement;
  state: MembershipState;
  /**
   * Milestone 1's view (`subscription` and `plan`); null when the account has no membership
   * (never a stand-in).
   */
  legacy: Membership | null;
  /** Display only. */
  paymentMethod: AccountDetails["paymentMethod"];
}

/** A provider membership counts once it has a subscription (a checkout that never got one does not). */
export function isProviderMembership(record: MembershipRecord | null): record is MembershipRecord {
  return record?.providerSubscriptionId != null;
}

export function snapshotMembership(
  record: MembershipRecord | null,
  legacy: SubscriptionRecord | null,
  graceSec: number,
  now: number,
): MembershipSnapshot {
  if (isProviderMembership(record)) {
    const effective = effectiveMembership(record, graceSec, now);
    // A first payment never confirmed (`none`): the account never subscribed (§5.2).
    const none = effective.status === "none";
    return {
      record,
      effective,
      entitlement: entitlementOf(effective),
      state: presentMembershipState(effective),
      legacy:
        none || effective.planId === null
          ? null
          : legacySubscriptionView(effective, record, effective.planId, now),
      paymentMethod: !none && record.paymentMethod ? { ...record.paymentMethod } : null,
    };
  }
  // Milestone 1's simulated membership: the seeded demo account's.
  const effective = legacyMembership(legacy, now);
  const held = legacy !== null && effective.status !== "none";
  return {
    record: null,
    effective,
    entitlement: entitlementOf(effective),
    state: presentMembershipState(effective),
    legacy: held
      ? { subscription: presentSubscription(legacy, now), plan: getPlan(legacy.planId) }
      : null,
    paymentMethod: held ? presentPaymentMethod(legacy) : null,
  };
}

export async function readMembership(
  deps: Pick<ServiceDependencies, "repos" | "config">,
  accountId: string,
  legacy: SubscriptionRecord | null,
  now: number,
): Promise<MembershipSnapshot> {
  const record = await deps.repos.billing.getMembership(accountId);
  return snapshotMembership(record, legacy, deps.config.billing.graceSec, now);
}

/**
 * Billing's part of `GET /session` (the identity area builds the rest): milestone 1's
 * `subscription` and `plan` (null without a membership), plus the projection and the
 * entitlement. One read of `memberships`. Pass the milestone 1 row when the caller already has
 * it (null when the account has none).
 */
export async function sessionMembership(
  deps: Pick<ServiceDependencies, "repos" | "config">,
  account: { id: string; createdAt: number },
  legacy: SubscriptionRecord | null,
  now: number,
): Promise<{
  subscription: Membership["subscription"] | null;
  plan: Membership["plan"] | null;
  membership: MembershipState;
  entitlement: Entitlement;
}> {
  const snapshot = await readMembership(deps, account.id, legacy, now);
  return {
    subscription: snapshot.legacy?.subscription ?? null,
    plan: snapshot.legacy?.plan ?? null,
    membership: snapshot.state,
    entitlement: snapshot.entitlement,
  };
}

/** `GET /account`: the account, milestone 1's subscription view, the projection and entitlement. */
export async function accountDetails(
  deps: Pick<ServiceDependencies, "repos" | "config">,
  loaded: { account: AccountRecord; subscription: SubscriptionRecord | null },
  now: number,
): Promise<AccountDetails> {
  const snapshot = await readMembership(deps, loaded.account.id, loaded.subscription, now);
  return {
    account: presentAccount(loaded.account),
    subscription: snapshot.legacy?.subscription ?? null,
    plan: snapshot.legacy?.plan ?? null,
    paymentMethod: snapshot.paymentMethod,
    membership: snapshot.state,
    entitlement: snapshot.entitlement,
  };
}
