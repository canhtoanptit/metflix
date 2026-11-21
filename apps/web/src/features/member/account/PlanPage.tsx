import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type AccountDetails, ApiError, type Plan, type PlanId } from "@webflix/contracts";
import { Button, Checkbox, ErrorState, RadioCard, RadioGroup, toast } from "@webflix/ui";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { cardErrorsFrom, describeDecline } from "../shared/billing.ts";
import { CardFields, type CardFieldsHandle, EMPTY_CARD } from "../shared/CardFields.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import { describeQuality, formatLongDate, formatMoney, formatScreens } from "../shared/format.ts";
import { PlanSummary, PlanSummarySkeleton } from "../shared/PlanSummary.tsx";
import { describeMemberError, useIsDemoAccount } from "../shared/privileges.ts";
import { TestCardsNote } from "../shared/TestCardsNote.tsx";
import { useFocusOnError } from "../shared/useFocusOnError.ts";
import { useSingleFlight } from "../shared/useSingleFlight.ts";
import { type CardFormErrors, toCardPayment } from "../shared/validation.ts";
import { AccountHeading } from "./AccountLayout.tsx";
import { applyMembership, describeCard, remainingPeriodFraction } from "./membership.ts";

/**
 * Change plan, or restart an ended membership. Before confirming, the member sees exactly what
 * changes: today's prorated charge for an upgrade, the new monthly price and date, screens and
 * quality, and that extra streams stop on a downgrade. A declined card changes nothing and
 * offers another card.
 */
export function AccountPlanPage() {
  const details = useQuery(queries.account());
  const plans = useQuery(queries.plans());

  if (details.isPending || plans.isPending) {
    return (
      <>
        <AccountHeading title="Membership" />
        <div className="grid gap-4 md:grid-cols-3">
          <PlanSummarySkeleton />
          <PlanSummarySkeleton />
          <PlanSummarySkeleton />
        </div>
      </>
    );
  }
  if (details.isError || plans.isError) {
    const error = details.error ?? plans.error;
    return (
      <>
        <AccountHeading title="Membership" />
        <ErrorState
          title="We couldn't load your plan"
          description={describeError(error).description}
          action={
            <Button
              variant="primary"
              onClick={() => {
                void details.refetch();
                void plans.refetch();
              }}
            >
              Try again
            </Button>
          }
        />
      </>
    );
  }
  return <PlanChooser details={details.data} plans={plans.data.items} />;
}

function PlanChooser({ details, plans }: { details: AccountDetails; plans: Plan[] }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const demo = useIsDemoAccount();
  const restarting = details.subscription.status === "ended";
  const [selectedId, setSelectedId] = useState<PlanId>(details.plan.id);
  const [newCard, setNewCard] = useState(details.paymentMethod === null);
  const [card, setCard] = useState(EMPTY_CARD);
  const [serverErrors, setServerErrors] = useState<CardFormErrors>({});
  const cardRef = useRef<CardFieldsHandle>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const flight = useSingleFlight();
  const selected = plans.find((plan) => plan.id === selectedId) ?? details.plan;
  const unchanged = !restarting && selected.id === details.plan.id;

  const change = useMutation({
    mutationFn: () =>
      api().changePlan({
        body: { planId: selected.id, ...(newCard ? { payment: toCardPayment(card) } : {}) },
      }),
    meta: { silent: true },
    onError: (error) => {
      setServerErrors(cardErrorsFrom(error));
      // Offer another card straight away.
      if (ApiError.is(error, "payment_declined")) setNewCard(true);
    },
    onSuccess: async (membership) => {
      applyMembership(queryClient, membership);
      toast.success(
        restarting ? `Welcome back to Webflix` : `You're now on ${membership.plan.name}`,
        {
          description: restarting
            ? "Your membership has restarted. Enjoy!"
            : `${formatScreens(membership.plan.maxStreams)}, up to ${describeQuality(membership.plan)}.`,
        },
      );
      await navigate({ to: "/account" });
    },
  });

  useFocusOnError(change.error, () => alertRef);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (flight.isBusy() || unchanged) return;
    if (newCard && !cardRef.current?.validate()) return;
    flight.run(() => change.mutateAsync());
  };

  const error = change.error;

  return (
    <>
      <AccountHeading
        title={restarting ? "Restart your membership" : "Change plan"}
        description={
          restarting
            ? "Pick a plan and you're back. Your profiles, My List and history are waiting."
            : demo
              ? `You're on ${details.plan.name}. The demo account's membership can't be changed.`
              : `You're on ${details.plan.name}. Changes apply straight away.`
        }
      />
      <form onSubmit={submit} noValidate className="flex flex-col gap-6" aria-label="Choose a plan">
        {ApiError.is(error, "payment_declined") ? (
          <FormAlert ref={alertRef} title={describeDecline(error.problem.declineReason).title}>
            {describeDecline(error.problem.declineReason).body} Your plan hasn't changed.
          </FormAlert>
        ) : error ? (
          <FormAlert ref={alertRef} title={describeMemberError(error).title}>
            {describeMemberError(error).description}
          </FormAlert>
        ) : null}

        <RadioGroup
          aria-label="Plans"
          value={selected.id}
          onValueChange={(value) => setSelectedId(value as PlanId)}
          disabled={demo}
          className="grid gap-4 md:grid-cols-3"
        >
          {plans.map((plan) => (
            <RadioCard key={plan.id} value={plan.id} className="h-full">
              <PlanSummary
                plan={plan}
                badge={plan.id === details.plan.id && !restarting ? "Your plan" : undefined}
              />
            </RadioCard>
          ))}
        </RadioGroup>

        {unchanged ? null : (
          <ChangeSummary details={details} next={selected} restarting={restarting} />
        )}

        {unchanged ? null : (
          <div className="flex flex-col gap-4">
            {details.paymentMethod ? (
              <Checkbox
                label="Use a different card"
                description={`Otherwise we'll charge ${describeCard(details.paymentMethod)}.`}
                checked={newCard}
                onCheckedChange={setNewCard}
              />
            ) : null}
            {newCard ? (
              <>
                <CardFields
                  ref={cardRef}
                  value={card}
                  onChange={(next) => {
                    setCard(next);
                    setServerErrors({});
                  }}
                  serverErrors={serverErrors}
                  disabled={change.isPending}
                />
                <TestCardsNote />
              </>
            ) : null}
          </div>
        )}

        {unchanged ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            {demo ? null : (
              <p className="type-body-sm text-fg-muted">
                Select another plan to see what changes before you confirm.
              </p>
            )}
            <Button variant="outline" size="lg" asChild>
              <Link to="/account">Back to account</Link>
            </Button>
          </div>
        ) : (
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="outline" size="lg" asChild>
              <Link to="/account">Cancel</Link>
            </Button>
            <Button type="submit" variant="accent" size="lg" loading={change.isPending}>
              {restarting ? `Restart with ${selected.name}` : `Switch to ${selected.name}`}
            </Button>
          </div>
        )}
        {details.subscription.status === "canceling" ? (
          <p className="type-body-sm text-fg-subtle">
            Your membership is still set to end on{" "}
            {formatLongDate(details.subscription.currentPeriodEnd)}. Changing plan doesn't undo
            that: choose Keep my membership on the Account page to continue.
          </p>
        ) : null}
      </form>
    </>
  );
}

/** What confirming will do, in plain words. */
function ChangeSummary({
  details,
  next,
  restarting,
}: {
  details: AccountDetails;
  next: Plan;
  restarting: boolean;
}) {
  const current = details.plan;
  const price = formatMoney(next.monthlyPrice);
  const lines: string[] = [];
  if (restarting) {
    lines.push(`You'll pay ${price} today, then every month until you cancel.`);
    lines.push(`Watch on ${formatScreens(next.maxStreams)}, up to ${describeQuality(next)}.`);
  } else {
    const difference = next.monthlyPrice.amountMinor - current.monthlyPrice.amountMinor;
    const renews = formatLongDate(details.subscription.currentPeriodEnd);
    if (difference > 0) {
      const today = Math.round(
        difference * remainingPeriodFraction(details.subscription.currentPeriodEnd),
      );
      lines.push(
        today > 0
          ? `You'll pay about ${formatMoney({ amountMinor: today, currency: next.monthlyPrice.currency })} today: the difference for the rest of this billing period.`
          : "Nothing extra to pay today.",
      );
    } else {
      lines.push("Nothing to pay today, and no refund for the current period.");
    }
    if (details.subscription.status === "active") {
      lines.push(`From ${renews}, you'll pay ${price} a month.`);
    }
    lines.push(`Starting now: ${formatScreens(next.maxStreams)}, up to ${describeQuality(next)}.`);
    if (next.maxStreams < current.maxStreams) {
      lines.push(
        `If more than ${next.maxStreams === 1 ? "one screen is" : `${next.maxStreams} screens are`} watching right now, the most recent streams will stop.`,
      );
    }
  }
  return (
    <FormAlert
      tone="info"
      title={restarting ? `Restarting with ${next.name}` : `Switching to ${next.name}`}
    >
      <ul className="mt-1 flex list-disc flex-col gap-1 ps-4">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </FormAlert>
  );
}
