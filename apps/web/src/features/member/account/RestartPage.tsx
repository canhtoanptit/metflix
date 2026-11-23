import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { qk } from "../../../app/query/keys.ts";
import { CheckoutConfirmation, returnedFrom } from "../billing/CheckoutConfirmation.tsx";
import { CheckoutPayment } from "../billing/CheckoutPayment.tsx";
import { AccountHeading } from "./AccountLayout.tsx";

const paymentRoute = getRouteApi("/account/account/membership/checkout");
const confirmRoute = getRouteApi("/account/account/membership/confirm");

function restartConfirmPath(checkoutId: string): string {
  return `/account/membership/confirm?checkout=${encodeURIComponent(checkoutId)}`;
}

/**
 * Restarting an ended membership: the same checkout as sign-up (the provider's form, a promo
 * code quoted first), inside Account. The account has had its trial, so what is due today, and
 * why (the account's credit, a code), is stated before anything is charged.
 */
export function AccountRestartPaymentPage() {
  const search = paymentRoute.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const planId = search.plan ?? "standard";
  const onConfirming = useCallback(
    (checkoutId: string, confirmedInPlace: boolean) => {
      void navigate({
        to: "/account/membership/confirm",
        search: { checkout: checkoutId, payment: confirmedInPlace ? "succeeded" : undefined },
        replace: !confirmedInPlace,
      });
    },
    [navigate],
  );
  const onConflict = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: qk.account.details() });
    void navigate({ to: "/account/membership", replace: true });
  }, [navigate, queryClient]);
  return (
    <>
      <AccountHeading
        title="Restart your membership"
        description="Your profiles, My List and viewing activity are all still here."
      />
      <CheckoutPayment
        planId={planId}
        changePlan={
          <Link
            to="/account/membership/plan"
            className="focus-ring shrink-0 rounded-xs type-label text-accent hover:underline"
          >
            Change<span className="sr-only"> plan</span>
          </Link>
        }
        confirmPath={restartConfirmPath}
        onConfirming={onConfirming}
        onConflict={onConflict}
        context="restart"
        declinedBefore={search.declined ?? null}
      />
    </>
  );
}

/** The confirming state of a restart; on success, straight back to watching. */
export function AccountRestartConfirmPage() {
  const search = confirmRoute.useSearch();
  const navigate = useNavigate();
  const checkoutId = search.checkout ?? "";
  return (
    <CheckoutConfirmation
      key={checkoutId}
      checkoutId={checkoutId}
      returned={returnedFrom(search)}
      selfPath={restartConfirmPath(checkoutId)}
      paymentHref={(planId) => `/account/membership/checkout?plan=${planId}`}
      planHref="/account/membership/plan"
      context="restart"
      next={{
        label: "Start watching",
        onContinue: () => void navigate({ to: "/browse", replace: true }),
      }}
    />
  );
}
