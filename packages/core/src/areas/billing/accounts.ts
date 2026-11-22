import type { AccountRecord, SubscriptionRecord } from "../../repositories/records.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import { effectiveMembership, legacySubscriptionView } from "./projection.ts";
import type { MembershipRecord } from "./repository.ts";

/**
 * The account and milestone 1's mock membership row, if any: one read of the identity area
 * (`repos.identity.getAccountWithSubscription`), which, unlike milestone 1's
 * `repos.accounts.get`, also answers for an account created without payment (§5.1).
 */
export async function readAccount(
  deps: Pick<ServiceDependencies, "repos">,
  accountId: string,
): Promise<{ account: AccountRecord; subscription: SubscriptionRecord | null } | null> {
  const loaded = await deps.repos.identity.getAccountWithSubscription(accountId);
  if (!loaded) return null;
  const { account, subscription } = loaded;
  return {
    account: {
      id: account.id,
      email: account.email,
      // Milestone 1's record spells "no password" as the empty string; billing never reads it.
      passwordHash: account.passwordHash ?? "",
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
    subscription,
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
