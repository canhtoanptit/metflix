import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Membership, PaymentMethod, SessionState } from "@webflix/contracts";
import { api } from "../../../app/api.ts";
import { qk } from "../../../app/query/keys.ts";
import { CARD_BRAND_LABELS } from "../shared/validation.ts";

/**
 * After any membership mutation: write the new subscription and plan into the cached session
 * and account details (every screen reads them), then refetch both.
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
  void queryClient.invalidateQueries({ queryKey: qk.session() });
}

export function useResumeMembership(
  options: { onSuccess?: (membership: Membership) => void } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api().resumeMembership(),
    meta: { silent: true },
    onSuccess: (membership) => {
      applyMembership(queryClient, membership);
      options.onSuccess?.(membership);
    },
  });
}

/** "Visa •••• 4242" */
export function describeCard(card: PaymentMethod): string {
  return `${CARD_BRAND_LABELS[card.brand]} •••• ${card.last4}`;
}

/** "Expires 08/2029" */
export function describeExpiry(card: PaymentMethod): string {
  return `Expires ${String(card.expMonth).padStart(2, "0")}/${card.expYear}`;
}

/** Remaining fraction of the current billing period (the server prorates upgrades by it). */
export function remainingPeriodFraction(currentPeriodEnd: string, now = Date.now()): number {
  const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
  return Math.min(1, Math.max(0, (new Date(currentPeriodEnd).getTime() - now) / PERIOD_MS));
}
