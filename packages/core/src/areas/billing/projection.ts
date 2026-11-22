import {
  type Entitlement,
  type MembershipState,
  type MembershipStatus,
  type PaymentProviderId,
  PLAN_IDS,
  type Plan,
  type PlanId,
  type Subscription,
} from "@webflix/contracts";
import { getPlan } from "../../domain/plans.ts";
import { toIsoString } from "../../ports/clock.ts";
import type {
  ProviderPaymentMethod,
  ProviderSubscription,
  ProviderSubscriptionStatus,
} from "../../ports/payment-provider.ts";
import type { CardBrand, StoredCard, SubscriptionRecord } from "../../repositories/records.ts";
import { effectiveSubscription } from "../../services/subscriptions.ts";
import type { MembershipRecord, SuspendedReason } from "./repository.ts";

/**
 * The membership state machine (docs/BLUEPRINT-M2.md §5.2, docs/STRIPE.md §9), as pure
 * functions. Two halves:
 *
 * - `projectMembership`: what is stored, computed only from the provider's own current state
 *   (a retrieved subscription), never from an event's contents or order. Applying the same
 *   provider state twice gives the same record (apart from its version and sync time), which is
 *   what makes duplicated and reordered deliveries converge.
 * - `effectiveMembership` / `entitlementOf`: what the stored record means *now*. Suspension after
 *   grace and the end of a cancelled period are computed from time, in the provider's time
 *   (`clockOffsetMs`), so they need no job and no provider event.
 */

/** Provider status → stored status (STRIPE.md §9; `incomplete_expired` returns to `none`). */
export const PROVIDER_STATUS_MAP: Record<
  ProviderSubscriptionStatus,
  { status: MembershipStatus; suspendedReason: SuspendedReason | null }
> = {
  incomplete: { status: "incomplete", suspendedReason: null },
  incomplete_expired: { status: "none", suspendedReason: null },
  trialing: { status: "trialing", suspendedReason: null },
  active: { status: "active", suspendedReason: null },
  past_due: { status: "past_due", suspendedReason: null },
  unpaid: { status: "suspended", suspendedReason: "unpaid" },
  paused: { status: "suspended", suspendedReason: "paused" },
  canceled: { status: "canceled", suspendedReason: null },
};

const LIVE: ReadonlySet<MembershipStatus> = new Set([
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "suspended",
]);
const ENTITLED: ReadonlySet<MembershipStatus> = new Set(["trialing", "active", "past_due"]);

/** `webflix.<plan>.monthly.<currency>` → the plan, or null for a key Webflix did not make. */
export function planFromLookupKey(lookupKey: string | null): PlanId | null {
  const plan = /^webflix\.([a-z]+)\.monthly\.[a-z]{3}$/.exec(lookupKey ?? "")?.[1];
  return plan && (PLAN_IDS as readonly string[]).includes(plan) ? (plan as PlanId) : null;
}

export function priceLookupKey(planId: PlanId, currency: string): string {
  return `webflix.${planId}.monthly.${currency.toLowerCase()}`;
}

export interface ProjectionInput {
  previous: MembershipRecord | null;
  accountId: string;
  provider: PaymentProviderId;
  subscription: ProviderSubscription;
  /** The earliest recorded `invoice.payment_failed` of the subscription's latest invoice. */
  firstFailureAt: number | null;
  /** Our time (epoch ms). */
  now: number;
}

/**
 * Whether a retrieved subscription is the account's current one. A late event about an old,
 * ended subscription must never overwrite a newer one (a member who restarted).
 */
export function supersedes(
  previous: MembershipRecord | null,
  subscription: ProviderSubscription,
): boolean {
  if (!previous?.providerSubscriptionId) return true;
  if (previous.providerSubscriptionId === subscription.id) return true;
  const incoming = PROVIDER_STATUS_MAP[subscription.status].status;
  const previousLive = LIVE.has(previous.status) && previous.status !== "incomplete";
  // A new live subscription replaces an ended (or never-paid) one; an ended one replaces nothing.
  return LIVE.has(incoming) && !previousLive;
}

/** The record the provider's current state projects to (the caller writes it with CAS). */
export function projectMembership(input: ProjectionInput): MembershipRecord {
  const { previous, subscription, now } = input;
  const mapped = PROVIDER_STATUS_MAP[subscription.status];
  const clockOffsetMs = subscription.clockNow === null ? 0 : subscription.clockNow - now;
  const providerNow = now + clockOffsetMs;
  const sameSubscription = previous?.providerSubscriptionId === subscription.id;

  let graceStartedAt: number | null = null;
  let graceInvoiceId: string | null = null;
  if (mapped.status === "past_due") {
    // Grace starts at the first failed attempt of the invoice now overdue: the earliest failure
    // event recorded for it, or what was already stored for it, or (neither known yet, e.g.
    // reconciliation ran before the failure event was recorded) now in the provider's time.
    // Taking the minimum makes the result independent of the order the facts arrive in.
    graceInvoiceId = subscription.latestInvoiceId;
    const candidates = [input.firstFailureAt];
    if (sameSubscription && previous?.graceInvoiceId === graceInvoiceId) {
      candidates.push(previous?.graceStartedAt ?? null);
    }
    const known = candidates.filter((value): value is number => value !== null);
    graceStartedAt = known.length > 0 ? Math.min(...known) : providerNow;
  }

  const trialing = subscription.status === "trialing";
  return {
    accountId: input.accountId,
    provider: input.provider,
    providerCustomerId: subscription.customerId,
    providerSubscriptionId: subscription.id,
    planId: planFromLookupKey(subscription.priceLookupKey) ?? previous?.planId ?? null,
    priceLookupKey: subscription.priceLookupKey,
    status: mapped.status,
    suspendedReason: mapped.suspendedReason,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    trialEndsAt: subscription.trialEnd,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    graceStartedAt,
    graceInvoiceId,
    endedAt: subscription.endedAt,
    latestInvoiceId: subscription.latestInvoiceId,
    paymentMethod: subscription.defaultPaymentMethod
      ? storedCard(subscription.defaultPaymentMethod)
      : sameSubscription
        ? (previous?.paymentMethod ?? null)
        : null,
    trialRedeemedAt:
      previous?.trialRedeemedAt ??
      (trialing && subscription.trialEnd !== null
        ? (subscription.currentPeriodStart ?? providerNow)
        : null),
    clockOffsetMs,
    version: (previous?.version ?? 0) + 1,
    providerSyncedAt: now,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Whether two records say the same thing (ignoring version and bookkeeping times). */
export function sameProjection(a: MembershipRecord | null, b: MembershipRecord): boolean {
  if (!a) return false;
  const strip = ({
    version: _v,
    providerSyncedAt: _s,
    updatedAt: _u,
    createdAt: _c,
    clockOffsetMs: _o,
    ...rest
  }: MembershipRecord) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

function storedCard(method: ProviderPaymentMethod): StoredCard {
  const brands: readonly CardBrand[] = ["visa", "mastercard", "amex", "discover"];
  const brand = (brands as readonly string[]).includes(method.brand)
    ? (method.brand as CardBrand)
    : "other";
  return { brand, last4: method.last4, expMonth: method.expMonth, expYear: method.expYear };
}

// --- Reading the projection now ---------------------------------------------------------------

/** What a membership means at a moment, all derived. */
export interface EffectiveMembership {
  status: MembershipStatus;
  suspendedReason: SuspendedReason | null;
  planId: PlanId | null;
  cancelAtPeriodEnd: boolean;
  /** Provider times (epoch ms), as the provider reports them. */
  trialEndsAt: number | null;
  currentPeriodEnd: number | null;
  graceEndsAt: number | null;
  /** When the entitlement ends unless something changes; null if open-ended. */
  entitledUntil: number | null;
  provider: PaymentProviderId | null;
}

export const NO_MEMBERSHIP: EffectiveMembership = {
  status: "none",
  suspendedReason: null,
  planId: null,
  cancelAtPeriodEnd: false,
  trialEndsAt: null,
  currentPeriodEnd: null,
  graceEndsAt: null,
  entitledUntil: null,
  provider: null,
};

/** The stored projection, read at `now` (our time) with `graceSec` of grace. */
export function effectiveMembership(
  record: MembershipRecord,
  graceSec: number,
  now: number,
): EffectiveMembership {
  const providerNow = now + record.clockOffsetMs;
  let status = record.status;
  let suspendedReason = record.suspendedReason;
  let graceEndsAt: number | null = null;
  const periodEnd =
    record.status === "trialing"
      ? (record.trialEndsAt ?? record.currentPeriodEnd)
      : record.currentPeriodEnd;

  if (record.status === "past_due") {
    graceEndsAt = (record.graceStartedAt ?? providerNow) + graceSec * 1000;
    // §5.2: suspension is computed from time, not from provider status: Webflix may suspend
    // while the provider is still retrying, and a later payment restores `active`.
    if (providerNow >= graceEndsAt) {
      status = "suspended";
      suspendedReason = "grace_expired";
    }
  } else if (
    (record.status === "trialing" || record.status === "active") &&
    record.cancelAtPeriodEnd &&
    periodEnd !== null &&
    providerNow >= periodEnd
  ) {
    // Cancelled and the period is over: ended, whether or not the provider's event has arrived.
    status = "canceled";
  }

  let entitledUntil: number | null = null;
  if (status === "past_due") entitledUntil = graceEndsAt;
  else if (ENTITLED.has(status) && record.cancelAtPeriodEnd) entitledUntil = periodEnd;

  return {
    status,
    suspendedReason: status === "suspended" ? suspendedReason : null,
    planId: record.planId,
    cancelAtPeriodEnd: record.cancelAtPeriodEnd && ENTITLED.has(status),
    trialEndsAt: record.trialEndsAt,
    currentPeriodEnd: record.currentPeriodEnd,
    graceEndsAt: status === "past_due" ? graceEndsAt : null,
    entitledUntil,
    provider: record.provider,
  };
}

/**
 * Milestone 1's mock membership read through the same states, so playback, the account page and
 * the staff console ask one question for every account. An account created without payment
 * (milestone 2 sign-up: no card stored) has no membership.
 */
export function legacyMembership(
  subscription: SubscriptionRecord | null,
  now: number,
): EffectiveMembership {
  if (!subscription || subscription.card === null) return NO_MEMBERSHIP;
  const effective = effectiveSubscription(subscription, now);
  const ended = effective.status === "ended";
  return {
    status: ended ? "canceled" : "active",
    suspendedReason: null,
    planId: subscription.planId,
    cancelAtPeriodEnd: effective.status === "canceling",
    trialEndsAt: null,
    currentPeriodEnd: effective.currentPeriodEnd,
    graceEndsAt: null,
    entitledUntil: effective.status === "canceling" ? effective.currentPeriodEnd : null,
    provider: null,
  };
}

/** §5.2: the one entitlement decision (playback, browse gates, the account page). */
export function entitlementOf(membership: EffectiveMembership): Entitlement {
  const entitled = ENTITLED.has(membership.status) && membership.planId !== null;
  const plan = membership.planId ? getPlan(membership.planId) : null;
  const reason: Entitlement["reason"] = entitled
    ? "entitled"
    : membership.status === "incomplete"
      ? "payment_pending"
      : membership.status === "suspended"
        ? "suspended"
        : membership.status === "canceled"
          ? "ended"
          : "no_membership";
  return {
    entitled,
    reason,
    maxStreams: entitled && plan ? plan.maxStreams : 0,
    maxVideoHeight: entitled && plan ? plan.maxVideoHeight : null,
    until:
      entitled && membership.entitledUntil !== null ? toIsoString(membership.entitledUntil) : null,
  };
}

export function presentMembershipState(membership: EffectiveMembership): MembershipState {
  const iso = (value: number | null) => (value === null ? null : toIsoString(value));
  return {
    status: membership.status,
    planId: membership.planId,
    cancelAtPeriodEnd: membership.cancelAtPeriodEnd,
    trialEndsAt: membership.status === "trialing" ? iso(membership.trialEndsAt) : null,
    currentPeriodEnd: iso(membership.currentPeriodEnd),
    graceEndsAt: iso(membership.graceEndsAt),
    suspendedReason: membership.suspendedReason,
    provider: membership.provider,
  };
}

/**
 * Milestone 1's `Subscription` view of a provider membership, for the clients that still read
 * it (`AccountDetails.subscription`, `Membership`): entitled → `active` (or `canceling`), anything
 * else → `ended`. The plan of a membership that never had one falls back to `fallbackPlan`.
 */
export function legacySubscriptionView(
  membership: EffectiveMembership,
  record: MembershipRecord | null,
  fallbackPlan: PlanId,
  now: number,
): { subscription: Subscription; plan: Plan } {
  const planId = membership.planId ?? fallbackPlan;
  const entitled = ENTITLED.has(membership.status);
  const periodEnd =
    membership.status === "trialing"
      ? (membership.trialEndsAt ?? membership.currentPeriodEnd)
      : membership.currentPeriodEnd;
  return {
    subscription: {
      planId,
      status: entitled ? (membership.cancelAtPeriodEnd ? "canceling" : "active") : "ended",
      startedAt: toIsoString(record?.createdAt ?? now),
      currentPeriodEnd: toIsoString(periodEnd ?? now),
      canceledAt: membership.cancelAtPeriodEnd
        ? toIsoString(record?.updatedAt ?? now)
        : record?.endedAt
          ? toIsoString(record.endedAt)
          : null,
    },
    plan: getPlan(planId),
  };
}
