import type {
  AccountDetails,
  Entitlement,
  Membership,
  MembershipState,
  PlanId,
} from "@webflix/contracts";
import { getPlan } from "../../domain/plans.ts";
import { toIsoString } from "../../ports/clock.ts";
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
  /** Milestone 1's view, for the clients that still read `subscription` and `plan`. */
  legacy: Membership;
  /** Display only. */
  paymentMethod: AccountDetails["paymentMethod"];
}

/** A provider membership counts once it has a subscription (a checkout that never got one does not). */
export function isProviderMembership(record: MembershipRecord | null): record is MembershipRecord {
  return record?.providerSubscriptionId != null;
}

/**
 * The plan milestone 1's view names for an account without a membership: its required
 * `subscription` and `plan` show an ended Basic membership since the account was created
 * (`membership.status` says `none`, which is the truth new clients read).
 */
export const NO_MEMBERSHIP_PLAN: PlanId = "basic";

/** Milestone 1's view of "no membership": ended, Basic, since the account was created. */
export function noMembershipView(accountCreatedAt: number): Membership {
  const at = toIsoString(accountCreatedAt);
  return {
    subscription: {
      planId: NO_MEMBERSHIP_PLAN,
      status: "ended",
      startedAt: at,
      currentPeriodEnd: at,
      canceledAt: at,
    },
    plan: getPlan(NO_MEMBERSHIP_PLAN),
  };
}

export function snapshotMembership(
  record: MembershipRecord | null,
  legacy: SubscriptionRecord | null,
  graceSec: number,
  now: number,
  accountCreatedAt: number = now,
): MembershipSnapshot {
  if (isProviderMembership(record)) {
    const effective = effectiveMembership(record, graceSec, now);
    return {
      record,
      effective,
      entitlement: entitlementOf(effective),
      state: presentMembershipState(effective),
      legacy: legacySubscriptionView(effective, record, legacy?.planId ?? NO_MEMBERSHIP_PLAN, now),
      paymentMethod: record.paymentMethod ? { ...record.paymentMethod } : null,
    };
  }
  const effective = legacyMembership(legacy, now);
  return {
    record: null,
    effective,
    entitlement: entitlementOf(effective),
    state: presentMembershipState(effective),
    legacy:
      legacy && effective.status !== "none"
        ? { subscription: presentSubscription(legacy, now), plan: getPlan(legacy.planId) }
        : noMembershipView(accountCreatedAt),
    paymentMethod: legacy && effective.status !== "none" ? presentPaymentMethod(legacy) : null,
  };
}

export async function readMembership(
  deps: Pick<ServiceDependencies, "repos" | "config">,
  accountId: string,
  legacy: SubscriptionRecord | null,
  now: number,
  accountCreatedAt?: number,
): Promise<MembershipSnapshot> {
  const record = await deps.repos.billing.getMembership(accountId);
  return snapshotMembership(record, legacy, deps.config.billing.graceSec, now, accountCreatedAt);
}

/**
 * Billing's part of `GET /session` (the identity area builds the rest): milestone 1's
 * `subscription` and `plan`, plus the projection and the entitlement. One read of
 * `memberships`. Pass the milestone 1 row when the caller already has it (null when the
 * account has none).
 */
export async function sessionMembership(
  deps: Pick<ServiceDependencies, "repos" | "config">,
  account: { id: string; createdAt: number },
  legacy: SubscriptionRecord | null,
  now: number,
): Promise<Membership & { membership: MembershipState; entitlement: Entitlement }> {
  const snapshot = await readMembership(deps, account.id, legacy, now, account.createdAt);
  return {
    ...snapshot.legacy,
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
  const snapshot = await readMembership(
    deps,
    loaded.account.id,
    loaded.subscription,
    now,
    loaded.account.createdAt,
  );
  return {
    account: presentAccount(loaded.account),
    subscription: snapshot.legacy.subscription,
    plan: snapshot.legacy.plan,
    paymentMethod: snapshot.paymentMethod,
    membership: snapshot.state,
    entitlement: snapshot.entitlement,
  };
}
