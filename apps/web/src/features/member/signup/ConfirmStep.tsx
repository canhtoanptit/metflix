import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { CheckoutConfirmation, returnedFrom } from "../billing/CheckoutConfirmation.tsx";
import { clearDraft } from "./draft.ts";
import { signupConfirmPath } from "./PaymentStep.tsx";
import { StepBody } from "./SignupLayout.tsx";

const route = getRouteApi("/public/signup/confirm");

/**
 * Step 3, continued: the payment is being confirmed (docs/BLUEPRINT-M2.md §5.1, step 4), then a
 * welcome and on to profiles. The checkout's id is in the URL, so a reload lands here again.
 */
export function ConfirmStep() {
  const search = route.useSearch();
  const navigate = useNavigate();
  // The route sends a visit without a checkout elsewhere.
  const checkoutId = search.checkout ?? "";
  return (
    <StepBody medium>
      <CheckoutConfirmation
        key={checkoutId}
        checkoutId={checkoutId}
        returned={returnedFrom(search)}
        selfPath={signupConfirmPath(checkoutId)}
        paymentHref={(planId) => `/signup/payment?plan=${planId}`}
        planHref="/signup/plan"
        next={{
          label: "Create your profiles",
          onContinue: () => {
            clearDraft();
            void navigate({ to: "/signup/profile", replace: true });
          },
        }}
      />
    </StepBody>
  );
}
