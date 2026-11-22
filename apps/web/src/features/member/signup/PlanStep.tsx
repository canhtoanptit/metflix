import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import type { PlanId } from "@webflix/contracts";
import { ArrowRightIcon, Button, ErrorState, RadioCard, RadioGroup } from "@webflix/ui";
import { type FormEvent, useState } from "react";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { useMembership } from "../../../app/session/session.ts";
import { NoProviderNotice } from "../billing/NoProviderNotice.tsx";
import { useBillingConfig } from "../billing/ProviderStep.tsx";
import { PlanSummary, PlanSummarySkeleton } from "../shared/PlanSummary.tsx";
import { readDraft, updateDraft } from "./draft.ts";
import { StepBody, StepHeading } from "./SignupLayout.tsx";

const route = getRouteApi("/public/signup/plan");

/**
 * Step 2: choose a plan, signed in. The choice lives in `?plan=` (and the tab's draft), so Back,
 * refresh and the "Change" link on the payment step all come back to it selected; a checkout in
 * progress or a first payment awaiting confirmation preselects its plan.
 */
export function PlanStep() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const { membership } = useMembership();
  const config = useBillingConfig();
  const plans = useQuery(queries.plans());
  // A checkout in progress (on this device or another) preselects its plan.
  const open = useQuery(queries.openCheckout());
  const [chosen, setChosen] = useState<PlanId | null>(
    () => search.plan ?? readDraft().planId ?? null,
  );
  const fallback = plans.data?.items.find((plan) => plan.highlighted)?.id ?? null;
  const selected = chosen ?? open.data?.checkout?.planId ?? membership.planId ?? fallback;
  const trialDays = plans.data?.items.find((plan) => plan.trial)?.trial?.days ?? null;

  const choose = (value: string) => {
    const planId = value as PlanId;
    setChosen(planId);
    updateDraft({ planId });
    // Keep the URL in step with the selection without adding history entries.
    void navigate({ to: "/signup/plan", search: { plan: planId }, replace: true });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    updateDraft({ planId: selected });
    void navigate({ to: "/signup/payment", search: { plan: selected } });
  };

  if (config.data?.provider === "none") {
    return (
      <StepBody>
        <NoProviderNotice headingLevel={1} />
      </StepBody>
    );
  }

  return (
    <StepBody wide>
      <div className="mx-auto w-full max-w-form md:max-w-prose md:text-center">
        <StepHeading
          step={2}
          title="Choose the plan that's right for you"
          description={
            trialDays
              ? `New members get ${trialDays} days free (one trial per member and per card): cancel before it ends and you won't be charged. Every plan has the whole catalog and no ads.`
              : "Every plan has the whole catalog and no ads. Change or cancel anytime."
          }
        />
      </div>
      <form
        onSubmit={submit}
        className="mx-auto flex w-full max-w-dialog-lg flex-col gap-8 lg:max-w-page"
      >
        {plans.isPending ? (
          <div className="grid gap-4 md:grid-cols-3" aria-busy="true">
            <PlanSummarySkeleton />
            <PlanSummarySkeleton />
            <PlanSummarySkeleton />
          </div>
        ) : plans.isError ? (
          <ErrorState
            title="We couldn't load the plans"
            description={describeError(plans.error).description}
            action={
              <Button variant="primary" onClick={() => void plans.refetch()}>
                Try again
              </Button>
            }
          />
        ) : (
          <RadioGroup
            aria-label="Plans"
            value={selected ?? undefined}
            onValueChange={choose}
            className="grid gap-4 md:grid-cols-3"
          >
            {plans.data.items.map((plan) => (
              <RadioCard key={plan.id} value={plan.id} className="h-full">
                <PlanSummary plan={plan} />
              </RadioCard>
            ))}
          </RadioGroup>
        )}
        <div className="mx-auto flex w-full max-w-form flex-col gap-4">
          <Button
            type="submit"
            variant="accent"
            size="lg"
            fullWidth
            iconAfter={ArrowRightIcon}
            disabled={!selected || !plans.isSuccess}
          >
            Continue
          </Button>
          <p className="type-body-sm text-fg-subtle md:text-center">
            How many screens you can watch on at once and the best video quality depend on your plan
            and your device. 4K needs a compatible screen and a fast connection.
          </p>
        </div>
      </form>
    </StepBody>
  );
}
