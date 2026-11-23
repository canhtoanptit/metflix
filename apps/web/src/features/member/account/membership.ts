import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AccountDetails,
  CARD_BRANDS,
  Membership,
  PaymentMethod,
  SessionState,
} from "@webflix/contracts";
import { useEffect } from "react";
import { api } from "../../../app/api.ts";
import { qk } from "../../../app/query/keys.ts";
import { queries } from "../../../app/query/queries.ts";
import { type MembershipView, membershipOf, sessionCache } from "../../../app/session/session.ts";

/**
 * After any membership mutation: write the new subscription and plan into the cached session
 * (every screen reads them), then refetch the session, the account and its billing reads, which
 * carry the membership projection as the provider now has it.
 */
export function applyMembership(
  queryClient: ReturnType<typeof useQueryClient>,
  membership: Membership,
): void {
  const session = queryClient.getQueryData<SessionState>(qk.session());
  if (session?.authenticated) {
    const next: SessionState = { ...session, ...membership };
    queryClient.setQueryData(qk.session(), next);
  }
  void queryClient.invalidateQueries({ queryKey: qk.account.details() });
  void queryClient.invalidateQueries({ queryKey: qk.account.billing() });
  void queryClient.invalidateQueries({ queryKey: qk.session() });
}

/**
 * `GET /account`, the account holder's view of the membership. Each answer is written into the
 * session too, so the profile gate, the paywall and Account agree on the same state.
 */
export function useAccountDetails() {
  const queryClient = useQueryClient();
  const details = useQuery(queries.account());
  const data = details.data;
  useEffect(() => {
    if (!data?.membership || !data.entitlement) return;
    const session = queryClient.getQueryData<SessionState>(qk.session());
    if (!session?.authenticated) return;
    if (
      JSON.stringify(session.membership) === JSON.stringify(data.membership) &&
      JSON.stringify(session.entitlement) === JSON.stringify(data.entitlement)
    ) {
      return;
    }
    sessionCache.applyMembership(queryClient, {
      membership: data.membership,
      entitlement: data.entitlement,
      subscription: data.subscription,
      plan: data.plan,
    });
  }, [data, queryClient]);
  return details;
}

/** The membership of loaded account details (milestone 1 accounts are read from their subscription). */
export function membershipOfDetails(details: AccountDetails): MembershipView {
  return membershipOf(details);
}

/**
 * A membership billed by milestone 1's built-in mock (the demo account, and accounts created with
 * the old card form): it has no provider, so changes go through milestone 1's routes and the
 * provider's flows (previews, card setup) do not apply to it.
 */
export function isLegacyMembership(view: MembershipView): boolean {
  return view.membership.provider === null && view.membership.status !== "none";
}

/**
 * The membership as the server now has it, after a change (the change's own answer is milestone
 * 1's view: no projection, no next invoice). Null when it cannot be read just now.
 */
export async function freshMembershipView(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<{ view: MembershipView; details: AccountDetails } | null> {
  try {
    const details = await queryClient.fetchQuery({ ...queries.account(), staleTime: 0 });
    return { view: membershipOfDetails(details), details };
  } catch {
    return null;
  }
}

/**
 * Keep a membership that is set to end. `onSuccess` gets the change's answer and the membership
 * as the server now has it (for words that match the page: `describeOutcome`).
 */
export function useResumeMembership(
  options: {
    onSuccess?: (
      membership: Membership,
      fresh: { view: MembershipView; details: AccountDetails } | null,
    ) => void;
    /** The refusal (the page shows `error` too). */
    onError?: (error: unknown) => void;
  } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api().resumeMembership(),
    meta: { silent: true },
    onSuccess: async (membership) => {
      applyMembership(queryClient, membership);
      options.onSuccess?.(membership, await freshMembershipView(queryClient));
    },
    onError: (error) => options.onError?.(error),
  });
}

const CARD_BRAND_LABELS: Record<(typeof CARD_BRANDS)[number], string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  other: "Card",
};

/** "Visa •••• 4242" */
export function describeCard(card: PaymentMethod): string {
  return `${CARD_BRAND_LABELS[card.brand]} •••• ${card.last4}`;
}

/** "Expires 08/2029" */
export function describeExpiry(card: PaymentMethod): string {
  return `Expires ${String(card.expMonth).padStart(2, "0")}/${card.expYear}`;
}

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Remaining fraction of the current billing period (milestone 1's mock prorates by it). */
export function remainingPeriodFraction(currentPeriodEnd: string, now = Date.now()): number {
  return Math.min(1, Math.max(0, (new Date(currentPeriodEnd).getTime() - now) / PERIOD_MS));
}

/**
 * What an upgrade of a milestone 1 mock membership charges now: the price difference for the
 * rest of the billing period, computed exactly as that mock computes it (`account.changePlan`:
 * the difference times the remaining fraction of the 30-day period, rounded to the cent). Only
 * for legacy memberships; a provider membership is previewed by the server
 * (`POST /billing/subscription/preview`) and charged exactly as previewed.
 */
export function upgradeChargeToday(
  currentMonthlyMinor: number,
  nextMonthlyMinor: number,
  currentPeriodEnd: string,
  now = Date.now(),
): { amountMinor: number; daysLeft: number } {
  const difference = nextMonthlyMinor - currentMonthlyMinor;
  const remainingMs = Math.max(0, new Date(currentPeriodEnd).getTime() - now);
  return {
    amountMinor: Math.max(
      0,
      Math.round(difference * remainingPeriodFraction(currentPeriodEnd, now)),
    ),
    daysLeft: Math.ceil(remainingMs / DAY_MS),
  };
}
