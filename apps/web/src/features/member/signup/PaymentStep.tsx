import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@webflix/ui";
import { useCallback, useState } from "react";
import { qk } from "../../../app/query/keys.ts";
import { queries } from "../../../app/query/queries.ts";
import { CheckoutPayment } from "../billing/CheckoutPayment.tsx";
import { resumeHref, signupStage } from "../billing/membership.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { readDraft } from "./draft.ts";
import { StepBody, StepHeading } from "./SignupLayout.tsx";

const route = getRouteApi("/public/signup/payment");

/** The confirming state of a sign-up checkout: the provider's form returns here. */
export function signupConfirmPath(checkoutId: string): string {
  return `/signup/confirm?checkout=${encodeURIComponent(checkoutId)}`;
}

/**
 * Step 3: pay in the provider's form (docs/BLUEPRINT-M2.md §5.1). What is due today and after
 * is shown before the member leaves for the form, a promo code is quoted before it applies, and
 * the card goes only to the provider. The confirming state (`/signup/confirm`) takes over once
 * the card is confirmed.
 */
export function PaymentStep() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The route guarantees one of the two (it sends the member to the plan step otherwise).
  const planId = search.plan ?? readDraft().planId ?? "standard";

  const onConfirming = useCallback(
    (checkoutId: string, confirmedInPlace: boolean) => {
      void navigate({
        to: "/signup/confirm",
        search: { checkout: checkoutId, payment: confirmedInPlace ? "succeeded" : undefined },
        replace: !confirmedInPlace,
      });
    },
    [navigate],
  );

  const [busyElsewhere, setBusyElsewhere] = useState(false);
  const onConflict = useCallback(async () => {
    // The membership moved without us (started elsewhere, or on hold): ask the server again.
    await queryClient.invalidateQueries({ queryKey: qk.session() });
    const session = await queryClient.ensureQueryData(queries.session());
    const stage = signupStage(session);
    if (session.authenticated && (stage === "plan" || stage === "payment")) {
      // A payment for another plan is being confirmed right now, perhaps on another device.
      const open = await queryClient.fetchQuery(queries.openCheckout()).catch(() => null);
      if (open?.checkout) {
        void navigate({ to: "/signup/confirm", search: { checkout: open.checkout.id } });
      } else {
        setBusyElsewhere(true);
      }
      return;
    }
    const href = await resumeHref(session, async () => null);
    void navigate({ href, replace: true });
  }, [navigate, queryClient]);

  return (
    <StepBody>
      <StepHeading
        step={3}
        title="Set up your payment"
        description="Your membership starts as soon as the payment provider confirms your card. No commitments: cancel online anytime."
      />
      {busyElsewhere ? (
        <FormAlert
          tone="info"
          title="A payment is already being confirmed for your account"
          action={
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              Check again
            </Button>
          }
        >
          It was started on another device or tab and usually takes a few seconds. Check again in a
          moment.
        </FormAlert>
      ) : null}
      <CheckoutPayment
        planId={planId}
        changePlan={
          <Link
            to="/signup/plan"
            search={{ plan: planId }}
            className="focus-ring inline-flex min-h-6 shrink-0 items-center rounded-xs type-label text-accent hover:underline"
          >
            Change<span className="sr-only"> plan</span>
          </Link>
        }
        confirmPath={signupConfirmPath}
        onConfirming={onConfirming}
        onConflict={onConflict}
        declinedBefore={search.declined ?? null}
      />
    </StepBody>
  );
}
