import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type AccountDetails,
  ApiError,
  type Plan,
  type PlanChangePreview,
  type PlanId,
} from "@webflix/contracts";
import { Button, ErrorState, RadioCard, RadioGroup, Skeleton, toast } from "@webflix/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import type { MembershipView } from "../../../app/session/session.ts";
import { describeDecline, formatSignedMoney } from "../billing/copy.ts";
import {
  DeletionScheduledNotice,
  isDeletionScheduled,
  useScheduledDeletion,
} from "../billing/deletion.tsx";
import { NoProviderNotice } from "../billing/NoProviderNotice.tsx";
import { useBillingConfig } from "../billing/ProviderStep.tsx";
import { patiently } from "../billing/polling.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { describeQuality, formatLongDate, formatMoney, formatScreens } from "../shared/format.ts";
import { PlanSummary, PlanSummarySkeleton } from "../shared/PlanSummary.tsx";
import { describeMemberError, useIsDemoAccount } from "../shared/privileges.ts";
import { useFocusOnError } from "../shared/useFocusOnError.ts";
import { useSingleFlight } from "../shared/useSingleFlight.ts";
import { AccountHeading } from "./AccountLayout.tsx";
import {
  applyMembership,
  describeCard,
  isLegacyMembership,
  membershipOfDetails,
  upgradeChargeToday,
  useAccountDetails,
} from "./membership.ts";

/**
 * Change plan, or choose one to restart an ended membership. A running membership at the payment
 * provider is previewed by the server before anything changes (`POST /billing/subscription/
 * preview`): what is charged or credited today, line by line, and the next payment, exactly as it
 * will be invoiced; confirming applies that very preview. A declined card changes nothing.
 */
export function AccountPlanPage() {
  const details = useAccountDetails();
  const plans = useQuery(queries.plans());
  const deletion = useScheduledDeletion();

  if (details.isPending || plans.isPending) {
    return (
      <>
        <AccountHeading title="Change plan" />
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
        <AccountHeading title="Change plan" />
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
  const view = membershipOfDetails(details.data);
  const status = view.membership.status;
  // Billing refuses to start, restart or change a provider membership while the account's
  // deletion is scheduled (milestone 1's mock membership is not guarded): say so, offer nothing.
  if (deletion && !isLegacyMembership(view)) {
    return (
      <>
        <AccountHeading
          title={
            status === "canceled" || status === "none" ? "Restart your membership" : "Change plan"
          }
        />
        <DeletionScheduledNotice scheduledFor={deletion.scheduledFor} />
        <div>
          <Button variant="outline" size="lg" asChild>
            <Link to="/account/membership">Back to membership</Link>
          </Button>
        </div>
      </>
    );
  }
  if (status === "canceled" || status === "none") {
    return <RestartChooser details={details.data} plans={plans.data.items} />;
  }
  if (status === "suspended" || status === "incomplete") {
    return <PlanChangeUnavailable view={view} />;
  }
  const member = asMember(details.data);
  if (!member) return <RestartChooser details={details.data} plans={plans.data.items} />;
  return isLegacyMembership(view) ? (
    <LegacyPlanChooser details={member} plans={plans.data.items} />
  ) : (
    <PlanChooser details={member} plans={plans.data.items} view={view} />
  );
}

/** Account details of an account that holds a membership (`plan` and `subscription` set). */
type MemberDetails = AccountDetails & {
  plan: Plan;
  subscription: NonNullable<AccountDetails["subscription"]>;
};

function asMember(details: AccountDetails): MemberDetails | null {
  return details.plan && details.subscription ? (details as MemberDetails) : null;
}

function PlanChangeUnavailable({ view }: { view: MembershipView }) {
  const onHold = view.membership.status === "suspended";
  return (
    <>
      <AccountHeading title="Change plan" />
      <FormAlert
        tone="accent"
        title={onHold ? "Your membership is on hold" : "Your first payment isn't confirmed yet"}
        action={
          <Button variant="accent" size="sm" asChild>
            {onHold ? (
              <Link to="/account/membership/payment">Update payment method</Link>
            ) : (
              <Link to="/signup">Finish payment</Link>
            )}
          </Button>
        }
      >
        {onHold
          ? "Update your payment method first: once the payment goes through you can change plan."
          : "You can change plan once your membership has started."}
      </FormAlert>
    </>
  );
}

/** A provider membership: choose, see the server's preview, confirm exactly that. */
function PlanChooser({
  details,
  plans,
  view,
}: {
  details: MemberDetails;
  plans: Plan[];
  view: MembershipView;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const demo = useIsDemoAccount();
  const current = details.plan;
  const [selectedId, setSelectedId] = useState<PlanId>(current.id);
  const selected = plans.find((plan) => plan.id === selectedId) ?? current;
  const unchanged = selected.id === current.id;
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [refreshed, setRefreshed] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const flight = useSingleFlight();

  // Every selection asks the server what it would cost now.
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    setRefreshed(false);
    if (unchanged || demo) return;
    let cancelled = false;
    patiently(() => api().previewPlanChange({ body: { planId: selected.id } })).then(
      (next) => !cancelled && setPreview(next),
      (error: unknown) => !cancelled && setPreviewError(error),
    );
    return () => {
      cancelled = true;
    };
  }, [selected.id, unchanged, demo]);

  const repreview = async () => {
    const next = await patiently(() => api().previewPlanChange({ body: { planId: selected.id } }));
    setPreview(next);
    setRefreshed(true);
  };

  // The preview travels with the request (never read from a closure that may predate it), so
  // what is applied is exactly what the member saw when they confirmed.
  const change = useMutation({
    mutationFn: async (shown: PlanChangePreview) => {
      // An expired preview would be refused: show the current amounts and ask again instead.
      if (Date.parse(shown.expiresAt) <= Date.now() + 5_000) {
        await repreview();
        return null;
      }
      return api().changePlan({
        body: { planId: shown.planId, previewToken: shown.previewToken },
      });
    },
    meta: { silent: true },
    onError: async (error) => {
      if (ApiError.is(error, "checkout_state_conflict")) await repreview().catch(() => undefined);
    },
    onSuccess: async (membership, shown) => {
      if (!membership) return;
      applyMembership(queryClient, membership);
      const charged = shown.amountDue.amountMinor > 0;
      toast.success(`You're now on ${membership.plan.name}`, {
        description: charged
          ? `${formatMoney(shown.amountDue)} was charged to your card.`
          : shown.nextRenewal
            ? `Your next payment is ${formatMoney(shown.nextRenewal.amount)} on ${formatLongDate(shown.nextRenewal.at)}.`
            : `${formatScreens(membership.plan.maxStreams)}, up to ${describeQuality(membership.plan)}.`,
      });
      await navigate({ to: "/account/membership" });
    },
  });

  useFocusOnError(change.error, () => alertRef);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (flight.isBusy() || unchanged || !preview || preview.planId !== selected.id) return;
    const shown = preview;
    flight.run(() => change.mutateAsync(shown));
  };

  const error = change.error;
  const declined = ApiError.is(error, "payment_declined")
    ? describeDecline(error.problem.declineReason)
    : null;

  return (
    <>
      <AccountHeading
        title="Change plan"
        description={
          demo
            ? `You're on ${current.name}. The demo account's membership can't be changed.`
            : `You're on ${current.name}. You'll see exactly what changes before you confirm.`
        }
      />
      <form onSubmit={submit} noValidate className="flex flex-col gap-6" aria-label="Choose a plan">
        {declined ? (
          <FormAlert
            ref={alertRef}
            title={declined.title}
            action={
              <Link
                to="/account/membership/payment"
                className="focus-ring rounded-xs type-label text-fg underline underline-offset-2"
              >
                Update payment method
              </Link>
            }
          >
            {declined.body} Your plan hasn't changed and nothing was charged.
          </FormAlert>
        ) : isDeletionScheduled(error) ? (
          <DeletionScheduledNotice />
        ) : ApiError.is(error, "checkout_state_conflict") ? (
          <FormAlert ref={alertRef} tone="info" title="The amounts have been updated">
            This preview had run out. Check the amounts below and confirm again.
          </FormAlert>
        ) : error ? (
          <FormAlert ref={alertRef} title={describeMemberError(error).title}>
            {describeMemberError(error).description} Your plan hasn't changed.
          </FormAlert>
        ) : refreshed ? (
          <FormAlert tone="info" title="The amounts have been updated">
            Some time passed since you chose this plan. Check the amounts below and confirm again.
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
              <PlanSummary plan={plan} badge={plan.id === current.id ? "Your plan" : undefined} />
            </RadioCard>
          ))}
        </RadioGroup>

        {unchanged ? null : previewError ? (
          <FormAlert
            title="We couldn't work out the cost of this change"
            action={
              <Button variant="outline" size="sm" onClick={() => setSelectedId(current.id)}>
                Keep my plan
              </Button>
            }
          >
            {describeMemberError(previewError).description} Nothing has changed.
          </FormAlert>
        ) : preview ? (
          <PreviewSummary
            preview={preview}
            current={current}
            next={selected}
            card={details.paymentMethod ? describeCard(details.paymentMethod) : null}
            trialing={view.membership.status === "trialing"}
          />
        ) : (
          <Skeleton className="h-48 w-full" radius="card" />
        )}

        {unchanged ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            {demo ? null : (
              <p className="type-body-sm text-fg-muted">
                Select another plan to see what changes before you confirm.
              </p>
            )}
            <Button variant="outline" size="lg" asChild>
              <Link to="/account/membership">Back to membership</Link>
            </Button>
          </div>
        ) : (
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="outline" size="lg" asChild>
              <Link to="/account/membership">Cancel</Link>
            </Button>
            <Button
              type="submit"
              variant="accent"
              size="lg"
              loading={change.isPending}
              disabled={!preview}
            >
              {preview && preview.amountDue.amountMinor > 0
                ? `Pay ${formatMoney(preview.amountDue)} and switch`
                : `Switch to ${selected.name}`}
            </Button>
          </div>
        )}
        {view.membership.cancelAtPeriodEnd ? (
          <p className="type-body-sm text-fg-subtle">
            Your membership is still set to end. Changing plan doesn't undo that: choose Keep my
            membership on the Membership page to continue.
          </p>
        ) : null}
      </form>
    </>
  );
}

/** The server's preview, line by line: exactly what the change invoices. */
function PreviewSummary({
  preview,
  current,
  next,
  card,
  trialing,
}: {
  preview: PlanChangePreview;
  current: Plan;
  next: Plan;
  card: string | null;
  trialing: boolean;
}) {
  const due = preview.amountDue.amountMinor > 0;
  return (
    <section
      aria-label={`Switching to ${next.name}`}
      className="flex flex-col gap-4 rounded-xl border border-line bg-surface-2 p-5"
      role="status"
    >
      <h2 className="type-title text-fg">Switching to {next.name}</h2>
      {preview.lines.length > 0 ? (
        <dl className="flex flex-col gap-2 type-body-sm">
          {preview.lines.map((line, index) => (
            <div key={`${line.description}-${index}`} className="flex justify-between gap-4">
              <dt className="text-fg-muted">{line.description}</dt>
              <dd className="text-fg tabular-nums">{formatSignedMoney(line.amount)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <dl className="flex flex-col gap-2 border-t border-line-subtle pt-3">
        <div className="flex justify-between gap-4">
          <dt className="type-label text-fg">{due ? "Charged today" : "To pay today"}</dt>
          <dd className="type-label text-fg tabular-nums">{formatMoney(preview.amountDue)}</dd>
        </div>
        {preview.credit.amountMinor > 0 ? (
          <div className="flex justify-between gap-4 type-body-sm">
            <dt className="text-fg-muted">Credit kept for your next payments</dt>
            <dd className="text-fg tabular-nums">{formatMoney(preview.credit)}</dd>
          </div>
        ) : null}
        {preview.nextRenewal ? (
          <div className="flex justify-between gap-4 type-body-sm">
            <dt className="text-fg-muted">
              {trialing ? "First payment" : "Next payment"},{" "}
              {formatLongDate(preview.nextRenewal.at)}
            </dt>
            <dd className="text-fg tabular-nums">{formatMoney(preview.nextRenewal.amount)}</dd>
          </div>
        ) : null}
      </dl>
      <ul className="flex list-disc flex-col gap-1 ps-4 type-body-sm text-fg-muted">
        {due ? (
          <li>
            {card ? `${card} is charged` : "Your card is charged"} {formatMoney(preview.amountDue)}{" "}
            when you confirm.
          </li>
        ) : (
          <li>Nothing is charged when you confirm.</li>
        )}
        <li>
          The change takes effect when you confirm: {formatScreens(next.maxStreams)}, up to{" "}
          {describeQuality(next)}.
        </li>
        {next.maxStreams < current.maxStreams ? (
          <li>
            If more than{" "}
            {next.maxStreams === 1 ? "one screen is" : `${next.maxStreams} screens are`} watching
            right now, the most recent streams will stop.
          </li>
        ) : null}
        <li>After that, {formatMoney(next.monthlyPrice)} a month, less any credit.</li>
      </ul>
    </section>
  );
}

/** An ended membership: choose a plan, then pay for it in a new checkout (no second trial). */
function RestartChooser({ details, plans }: { details: AccountDetails; plans: Plan[] }) {
  const navigate = useNavigate();
  const demo = useIsDemoAccount();
  const config = useBillingConfig();
  const [selectedId, setSelectedId] = useState<PlanId>(details.plan?.id ?? "standard");
  if (config.data?.provider === "none") {
    return (
      <>
        <AccountHeading title="Restart your membership" />
        <NoProviderNotice>
          This Webflix isn't set up to take payments, so a membership can't be restarted on it right
          now. Your profiles, My List and viewing activity are still here.
        </NoProviderNotice>
      </>
    );
  }
  // The plans list always holds every plan; `details.plan` is null without a membership.
  const selected = (plans.find((plan) => plan.id === selectedId) ??
    details.plan ??
    plans[0]) as Plan;
  return (
    <>
      <AccountHeading
        title="Restart your membership"
        description="Pick a plan and you're back. Your profiles, My List and history are waiting."
      />
      <form
        noValidate
        className="flex flex-col gap-6"
        aria-label="Choose a plan"
        onSubmit={(event) => {
          event.preventDefault();
          if (demo) return;
          void navigate({ to: "/account/membership/checkout", search: { plan: selected.id } });
        }}
      >
        <RadioGroup
          aria-label="Plans"
          value={selected.id}
          onValueChange={(value) => setSelectedId(value as PlanId)}
          disabled={demo}
          className="grid gap-4 md:grid-cols-3"
        >
          {plans.map((plan) => (
            <RadioCard key={plan.id} value={plan.id} className="h-full">
              <PlanSummary plan={plan} />
            </RadioCard>
          ))}
        </RadioGroup>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="outline" size="lg" asChild>
            <Link to="/account/membership">Cancel</Link>
          </Button>
          <Button type="submit" variant="accent" size="lg" disabled={demo}>
            Continue with {selected.name}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * A milestone 1 mock membership (no provider): changed through milestone 1's route without a
 * card; the card on file is charged, and the charge is computed exactly as that mock computes it.
 */
function LegacyPlanChooser({ details, plans }: { details: MemberDetails; plans: Plan[] }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const demo = useIsDemoAccount();
  const [selectedId, setSelectedId] = useState<PlanId>(details.plan.id);
  const alertRef = useRef<HTMLDivElement>(null);
  const flight = useSingleFlight();
  const selected = plans.find((plan) => plan.id === selectedId) ?? details.plan;
  const unchanged = selected.id === details.plan.id;

  const change = useMutation({
    mutationFn: (planId: PlanId) => api().changePlan({ body: { planId } }),
    meta: { silent: true },
    onSuccess: async (membership) => {
      applyMembership(queryClient, membership);
      toast.success(`You're now on ${membership.plan.name}`, {
        description: `${formatScreens(membership.plan.maxStreams)}, up to ${describeQuality(membership.plan)}.`,
      });
      await navigate({ to: "/account/membership" });
    },
  });
  useFocusOnError(change.error, () => alertRef);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (flight.isBusy() || unchanged) return;
    const planId = selected.id;
    flight.run(() => change.mutateAsync(planId));
  };
  const error = change.error;

  return (
    <>
      <AccountHeading
        title="Change plan"
        description={
          demo
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
                badge={plan.id === details.plan.id ? "Your plan" : undefined}
              />
            </RadioCard>
          ))}
        </RadioGroup>
        {unchanged ? null : <LegacyChangeSummary details={details} next={selected} />}
        {unchanged ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            {demo ? null : (
              <p className="type-body-sm text-fg-muted">
                Select another plan to see what changes before you confirm.
              </p>
            )}
            <Button variant="outline" size="lg" asChild>
              <Link to="/account/membership">Back to membership</Link>
            </Button>
          </div>
        ) : (
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="outline" size="lg" asChild>
              <Link to="/account/membership">Cancel</Link>
            </Button>
            <Button type="submit" variant="accent" size="lg" loading={change.isPending}>
              Switch to {selected.name}
            </Button>
          </div>
        )}
      </form>
    </>
  );
}

function LegacyChangeSummary({ details, next }: { details: MemberDetails; next: Plan }) {
  const current = details.plan;
  const lines: string[] = [];
  const difference = next.monthlyPrice.amountMinor - current.monthlyPrice.amountMinor;
  if (difference > 0) {
    const charge = upgradeChargeToday(
      current.monthlyPrice.amountMinor,
      next.monthlyPrice.amountMinor,
      details.subscription.currentPeriodEnd,
    );
    const days = charge.daysLeft === 1 ? "the 1 day" : `the ${charge.daysLeft} days`;
    lines.push(
      charge.amountMinor > 0
        ? `We'll charge ${formatMoney({ amountMinor: charge.amountMinor, currency: next.monthlyPrice.currency })} today: the difference in price for ${days} left in this billing period.`
        : "Nothing extra to pay today.",
    );
  } else {
    lines.push("Nothing to pay today, and no refund for the current period.");
  }
  if (details.subscription.status === "active") {
    lines.push(
      `From ${formatLongDate(details.subscription.currentPeriodEnd)}, you'll pay ${formatMoney(next.monthlyPrice)} a month.`,
    );
  }
  lines.push(`Starting now: ${formatScreens(next.maxStreams)}, up to ${describeQuality(next)}.`);
  if (next.maxStreams < current.maxStreams) {
    lines.push(
      `If more than ${next.maxStreams === 1 ? "one screen is" : `${next.maxStreams} screens are`} watching right now, the most recent streams will stop.`,
    );
  }
  return (
    <FormAlert tone="info" title={`Switching to ${next.name}`}>
      <ul className="mt-1 flex list-disc flex-col gap-1 ps-4">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </FormAlert>
  );
}
