import type { AccountRecord, SubscriptionRecord } from "../../repositories/records.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import { effectiveMembership, legacySubscriptionView } from "./projection.ts";
import type { MembershipRecord } from "./repository.ts";

/**
 * The account and milestone 1's mock membership row, if any.
 *
 * STAND-IN (needs from identity): milestone 1's `repos.accounts.get` joins `subscriptions` and
 * answers null for an account created without payment (milestone 2 sign-up), so billing falls
 * back to the identity area's account read for such accounts. Replace both with one identity
 * read that returns the account with a nullable subscription when identity offers it.
 */
export async function readAccount(
  deps: Pick<ServiceDependencies, "repos">,
  accountId: string,
): Promise<{ account: AccountRecord; subscription: SubscriptionRecord | null } | null> {
  const loaded = await deps.repos.accounts.get(accountId);
  if (loaded) return loaded;
  const identity = await deps.repos.identity.getAccount(accountId);
  if (!identity) return null;
  return {
    account: {
      id: identity.id,
      email: identity.email,
      passwordHash: identity.passwordHash ?? "",
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
    },
    subscription: null,
  };
}

/**
 * Keeps milestone 1's `subscriptions` row of a provider member in step with the projection, in
 * milestone 1's terms: entitled → active (or canceling at the period end), anything else →
 * ended. It is a compatibility mirror for the readers that still use that row (the session's
 * `subscription` and `plan`, playback's account load); every billing decision reads the
 * projection itself, never the mirror. Written only right after the projection was.
 */
export async function mirrorLegacySubscription(
  deps: Pick<ServiceDependencies, "repos">,
  record: MembershipRecord,
  graceSec: number,
  now: number,
): Promise<void> {
  const effective = effectiveMembership(record, graceSec, now);
  const view = legacySubscriptionView(effective, record, record.planId ?? "standard", now);
  const entitled = view.subscription.status !== "ended";
  const periodEnd =
    (effective.status === "trialing" ? effective.trialEndsAt : effective.currentPeriodEnd) ?? now;
  const ended = record.endedAt ?? now;
  await deps.repos.accounts.saveSubscription({
    accountId: record.accountId,
    planId: view.plan.id,
    startedAt: record.createdAt,
    currentPeriodEnd: entitled ? periodEnd : Math.min(ended, now),
    canceledAt: entitled ? (effective.cancelAtPeriodEnd ? now : null) : Math.min(ended, now),
    card: record.paymentMethod,
    updatedAt: now,
  });
}
