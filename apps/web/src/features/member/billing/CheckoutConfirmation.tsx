import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError, type Checkout, type PlanId } from "@webflix/contracts";
import {
  AlertCircleIcon,
  Button,
  CheckCircleIcon,
  ClockIcon,
  ErrorReference,
  InfoIcon,
  Skeleton,
} from "@webflix/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { qk } from "../../../app/query/keys.ts";
import { queries } from "../../../app/query/queries.ts";
import { useAuthenticatedSession, useMembership } from "../../../app/session/session.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatLongDate, formatMoney } from "../shared/format.ts";
import { clearHandOff, handOffOf, markHandedOff } from "./checkoutMemory.ts";
import { type DeclineReason, describeDecline, promotionAmount, promotionReach } from "./copy.ts";
import { deletionBody, deletionTitle, useScheduledDeletion } from "./deletion.tsx";
import { HrefLink } from "./HrefLink.tsx";
import { describeAmountReason, describeOutcome, membershipOutcome } from "./outcome.ts";
import { ProviderStep, useBillingConfig } from "./ProviderStep.tsx";
import { patiently, usePoll } from "./polling.ts";
import { StatusPanel } from "./StatusPanel.tsx";

/** Waiting on the provider: "taking longer than usual" after this long. */
const SLOW_MS = 15_000;
/** Then offer "Check again" (polling carries on regardless). */
const VERY_SLOW_MS = 120_000;
/** Back from a first-payment form, a checkout still unpaid after this long was not paid. */
const UNPAID_AFTER_MS = 8_000;

type Phase =
  | { kind: "loading" }
  | { kind: "needs-payment"; checkout: Checkout; notice: FirstPaymentNotice }
  | { kind: "waiting"; awaitingPayment: boolean }
  | { kind: "complete"; checkout: Checkout }
  | { kind: "declined"; reason: DeclineReason | null; planId: PlanId | null }
  | { kind: "unconfirmed"; planId: PlanId }
  | { kind: "failed"; checkout: Checkout }
  | { kind: "expired"; checkout: Checkout }
  | { kind: "missing" }
  /** Confirming was refused: the account's deletion is scheduled. */
  | { kind: "deletion" }
  | { kind: "error"; error: unknown };

/**
 * What the provider said on the way back: the fake provider's form appends `payment`, Stripe's
 * redirect `redirect_status`.
 */
export function returnedFrom(search: {
  payment?: "succeeded" | "failed";
  redirect_status?: "succeeded" | "processing" | "failed";
}): "succeeded" | "failed" | null {
  if (search.payment === "failed" || search.redirect_status === "failed") return "failed";
  if (search.payment === "succeeded" || search.redirect_status === "succeeded") return "succeeded";
  return null;
}

export interface CheckoutConfirmationProps {
  checkoutId: string;
  /**
   * What the provider's form said on the way back (`payment=succeeded` or `failed`), or null.
   * `failed` covers a decline and a member who chose to return without paying alike, so the
   * server is asked what actually happened.
   */
  returned: "succeeded" | "failed" | null;
  /** This page, for the provider to return to after a first payment. */
  selfPath: string;
  /** The payment step for a plan (another card, start again). */
  paymentHref: (planId: PlanId) => string;
  /** The plan choice. */
  planHref: string;
  /** Where to go once the membership is active. */
  next: { label: string; onContinue: () => void };
  /** A new member's first payment, or a returning member's restart (never "first payment"). */
  context?: "signup" | "restart";
}

/**
 * Confirming a payment (docs/BLUEPRINT-M2.md §5.1, step 4): the membership is active only once
 * the provider says so, which can take seconds, pass through a 3-D Secure challenge, or fail.
 * Everything shown here is what the server answered: the card confirmed with the provider is
 * reported to Webflix (`POST /billing/checkout/:id/confirm`), a first payment is asked for when
 * there is no trial, and the checkout is polled until it settles. The checkout's id is in the
 * URL and remembered by the browser, so a reload, a closed tab or a slow provider all come back
 * to the same state.
 */
export function CheckoutConfirmation({
  checkoutId,
  returned,
  selfPath,
  paymentHref,
  planHref,
  next,
  context = "signup",
}: CheckoutConfirmationProps) {
  const session = useAuthenticatedSession();
  const accountId = session.account.id;
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [run, setRun] = useState(0);
  const settledOnce = useRef(false);

  const finish = useCallback(
    async (checkout: Checkout) => {
      if (settledOnce.current) return;
      settledOnce.current = true;
      clearHandOff();
      // The session must carry the new membership before the next step's guard reads it.
      void queryClient.invalidateQueries({ queryKey: qk.account.billing() });
      await queryClient.invalidateQueries({ queryKey: qk.session() });
      setPhase({ kind: "complete", checkout });
    },
    [queryClient],
  );

  const settle = useCallback(
    (checkout: Checkout, options: { awaitingPayment: boolean; notice?: FirstPaymentNotice }) => {
      switch (checkout.status) {
        case "complete":
          void finish(checkout);
          return;
        case "failed":
          clearHandOff();
          setPhase({ kind: "failed", checkout });
          return;
        case "expired":
          clearHandOff();
          setPhase({ kind: "expired", checkout });
          return;
        case "requires_payment":
          setPhase(
            options.awaitingPayment
              ? { kind: "waiting", awaitingPayment: true }
              : { kind: "needs-payment", checkout, notice: options.notice ?? null },
          );
          return;
        case "processing":
          setPhase({ kind: "waiting", awaitingPayment: false });
          return;
        case "requires_setup":
          setPhase({ kind: "unconfirmed", planId: checkout.planId });
          return;
      }
    },
    [finish],
  );

  useEffect(() => {
    let cancelled = false;
    settledOnce.current = false;
    setPhase({ kind: "loading" });
    const handedOff = handOffOf(accountId, checkoutId);
    (async () => {
      const checkout = await patiently(() => api().getCheckout({ params: { id: checkoutId } }), 6);
      if (cancelled) return;
      if (checkout.status !== "requires_setup") {
        // Back from the payment form: succeeded (wait for the provider), or failed (a decline or
        // a member who returned without paying: the form shows the payment again, and says so).
        const awaitingPayment =
          checkout.status === "requires_payment" &&
          returned !== "failed" &&
          (returned === "succeeded" || handedOff === "payment");
        if (handedOff) clearHandOff();
        settle(checkout, {
          awaitingPayment,
          notice: returned === "failed" ? "not-completed" : null,
        });
        return;
      }
      // The card was confirmed with the provider (or the member came back without it): tell
      // Webflix, which reads the card, decides the trial and creates the subscription.
      if (handedOff) clearHandOff();
      try {
        const confirmed = await patiently(() =>
          api().confirmCheckout({ params: { id: checkoutId } }),
        );
        if (!cancelled) settle(confirmed, { awaitingPayment: false });
      } catch (error) {
        if (cancelled) return;
        if (ApiError.is(error, "payment_declined")) {
          setPhase({
            kind: "declined",
            reason: error.problem.declineReason,
            planId: checkout.planId,
          });
        } else if (ApiError.is(error, "account_deletion_scheduled")) {
          setPhase({ kind: "deletion" });
        } else if (ApiError.is(error, "checkout_state_conflict")) {
          setPhase({ kind: "unconfirmed", planId: checkout.planId });
        } else {
          throw error;
        }
      }
    })().catch((error: unknown) => {
      if (cancelled) return;
      setPhase(ApiError.is(error, "not_found") ? { kind: "missing" } : { kind: "error", error });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, checkoutId, run]);

  const waiting = phase.kind === "waiting";
  const poll = usePoll(
    `${checkoutId}:${run}`,
    () => api().getCheckout({ params: { id: checkoutId } }),
    {
      active: waiting,
      settled: (checkout) => !["processing", "requires_payment"].includes(checkout.status),
    },
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [waiting]);
  const elapsed = now - poll.startedAt;

  useEffect(() => {
    if (!waiting) return;
    if (poll.error) {
      setPhase(
        ApiError.is(poll.error, "not_found")
          ? { kind: "missing" }
          : { kind: "error", error: poll.error },
      );
      return;
    }
    const checkout = poll.value;
    if (!checkout) return;
    if (checkout.status === "requires_payment") {
      if (phase.kind === "waiting" && phase.awaitingPayment && elapsed > UNPAID_AFTER_MS) {
        setPhase({ kind: "needs-payment", checkout, notice: "not-yet" });
      } else if (phase.kind === "waiting" && !phase.awaitingPayment) {
        setPhase({ kind: "needs-payment", checkout, notice: null });
      }
      return;
    }
    if (checkout.status !== "processing") settle(checkout, { awaitingPayment: false });
  }, [waiting, poll.value, poll.error, elapsed, phase, settle]);

  const retry = () => setRun((value) => value + 1);

  switch (phase.kind) {
    case "loading":
    case "waiting":
      return (
        <StatusPanel
          stateKey="confirming"
          busy
          title="Confirming your payment"
          actions={
            elapsed > VERY_SLOW_MS ? (
              <Button variant="primary" size="lg" onClick={retry}>
                Check again
              </Button>
            ) : undefined
          }
        >
          <p role="status">
            {poll.troubled
              ? "We're having trouble reaching Webflix. We'll keep trying, so you can stay on this page."
              : phase.kind === "waiting" && elapsed > SLOW_MS
                ? "This is taking longer than usual: your bank may still be checking the payment."
                : "This usually takes a few seconds. This page updates by itself."}
          </p>
          {phase.kind === "waiting" && elapsed > SLOW_MS ? (
            <p>
              You can wait here, or close this page: your membership starts as soon as the payment
              is confirmed, and signing in again brings you back here.
            </p>
          ) : null}
        </StatusPanel>
      );
    case "needs-payment":
      return (
        <FirstPayment
          checkout={phase.checkout}
          context={context}
          notice={phase.notice}
          selfPath={selfPath}
          planHref={planHref}
          onHandOff={() => markHandedOff(accountId, checkoutId, "payment")}
          onPaidInPlace={() => setPhase({ kind: "waiting", awaitingPayment: true })}
        />
      );
    case "complete":
      return <Welcome checkout={phase.checkout} next={next} />;
    case "declined": {
      const copy = describeDecline(phase.reason);
      return (
        <StatusPanel
          stateKey="declined"
          icon={AlertCircleIcon}
          tone="danger"
          title={copy.title}
          actions={
            <>
              <Button variant="accent" size="lg" asChild>
                <HrefLink
                  href={
                    phase.planId
                      ? `${paymentHref(phase.planId)}&declined=${phase.reason ?? "unknown"}`
                      : planHref
                  }
                >
                  Use another card
                </HrefLink>
              </Button>
              <Button variant="outline" size="lg" asChild>
                <HrefLink href={planHref}>Choose another plan</HrefLink>
              </Button>
            </>
          }
        >
          <p>{copy.body} Nothing was charged, and your membership hasn't started.</p>
        </StatusPanel>
      );
    }
    case "unconfirmed":
      return (
        <StatusPanel
          stateKey="unconfirmed"
          icon={InfoIcon}
          title="No card was added"
          actions={
            <Button variant="accent" size="lg" asChild>
              <HrefLink href={paymentHref(phase.planId)}>Add a card</HrefLink>
            </Button>
          }
        >
          <p>
            You came back from the payment page before a card was confirmed, so nothing was charged
            and your membership hasn't started.
          </p>
        </StatusPanel>
      );
    case "failed": {
      const copy = describeDecline(phase.checkout.failureReason);
      return (
        <StatusPanel
          stateKey="failed"
          icon={AlertCircleIcon}
          tone="danger"
          title="We couldn't start your membership"
          actions={
            <Button variant="accent" size="lg" asChild>
              <HrefLink href={paymentHref(phase.checkout.planId)}>Try again</HrefLink>
            </Button>
          }
        >
          <p>
            {copy.title}. {copy.body} Nothing was charged.
          </p>
        </StatusPanel>
      );
    }
    case "expired":
      return (
        <StatusPanel
          stateKey="expired"
          icon={ClockIcon}
          title="This payment has expired"
          actions={
            <Button variant="accent" size="lg" asChild>
              <HrefLink href={paymentHref(phase.checkout.planId)}>Start again</HrefLink>
            </Button>
          }
        >
          <p>
            It wasn't completed in time, so nothing was charged. Start again to pay for your
            membership.
          </p>
        </StatusPanel>
      );
    case "deletion":
      return <DeletionPanel />;
    case "missing":
      return (
        <StatusPanel
          stateKey="missing"
          icon={InfoIcon}
          title="We can't find this payment"
          actions={
            <Button variant="accent" size="lg" asChild>
              <HrefLink href={planHref}>Choose a plan</HrefLink>
            </Button>
          }
        >
          <p>The link may be out of date. Nothing was charged.</p>
        </StatusPanel>
      );
    case "error": {
      const described = describeError(phase.error);
      return (
        <StatusPanel
          stateKey="error"
          icon={AlertCircleIcon}
          tone="danger"
          title="We couldn't check your payment"
          actions={
            <Button variant="primary" size="lg" onClick={retry}>
              Try again
            </Button>
          }
          footer={described.reference ? <ErrorReference reference={described.reference} /> : null}
        >
          <p>
            {described.description} If you already paid, your payment is safe: checking again picks
            up where it left off.
          </p>
        </StatusPanel>
      );
    }
  }
}

/** The account's deletion is scheduled: nothing is charged, and keeping it comes first. */
function DeletionPanel() {
  const deletion = useScheduledDeletion();
  return (
    <StatusPanel
      stateKey="deletion"
      icon={InfoIcon}
      tone="accent"
      title={deletionTitle(deletion?.scheduledFor)}
      actions={
        <Button variant="accent" size="lg" asChild>
          <Link to="/account/privacy">Go to Privacy</Link>
        </Button>
      }
    >
      <p>{deletionBody(null, deletion?.scheduledFor)}</p>
    </StatusPanel>
  );
}

/** No trial this time: the first payment, confirmed in the provider's form. */
/** Why the first payment is shown again: not received yet, or not completed at the provider. */
type FirstPaymentNotice = "not-yet" | "not-completed" | null;

function FirstPayment({
  checkout,
  context,
  notice,
  selfPath,
  planHref,
  onHandOff,
  onPaidInPlace,
}: {
  checkout: Checkout;
  context: "signup" | "restart";
  notice: FirstPaymentNotice;
  selfPath: string;
  planHref: string;
  onHandOff: () => void;
  onPaidInPlace: () => void;
}) {
  const config = useBillingConfig();
  const plans = useQuery(queries.plans());
  const plan = plans.data?.items.find((candidate) => candidate.id === checkout.planId) ?? null;
  const due = checkout.amountDue;
  const restart = context === "restart";
  // Why it is that amount: "$7.99 less your $4.98 credit" (the account's credit, the code).
  const reason = describeAmountReason(due, {
    creditApplied: checkout.creditApplied,
    discount: checkout.discount,
    code: checkout.promotion?.code,
  });
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [notice]);
  return (
    <section
      aria-labelledby="first-payment-title"
      className="flex flex-col gap-6"
      data-state="payment"
    >
      <header className="flex flex-col gap-2">
        <h1
          ref={heading}
          id="first-payment-title"
          tabIndex={-1}
          className="type-headline text-fg outline-none"
        >
          {restart
            ? plan
              ? `Restart ${plan.name}`
              : "Restart your membership"
            : "Confirm your first payment"}
        </h1>
        <p className="type-body-lg text-fg-muted">
          {restart
            ? "Your card is saved. Now confirm the payment on our payment provider's secure page and you're back straight away: your profiles, My List and viewing activity are all still here."
            : "Your card is saved, but there's no free trial this time: this card has had one before. Confirm the first payment and your membership starts."}
        </p>
      </header>
      {notice === "not-yet" ? (
        <FormAlert tone="info" title="We haven't received your payment yet">
          If you've just paid, wait a moment and reload this page. Otherwise, confirm it below.
        </FormAlert>
      ) : notice === "not-completed" ? (
        <FormAlert
          tone={checkout.failureReason ? "danger" : "info"}
          title={
            checkout.failureReason
              ? describeDecline(checkout.failureReason).title
              : "Your payment wasn't completed"
          }
        >
          {checkout.failureReason
            ? `${describeDecline(checkout.failureReason).body} `
            : "If your card was declined, you can choose another card on the payment page. "}
          Nothing was charged.
        </FormAlert>
      ) : null}
      <dl className="flex flex-col gap-3 rounded-xl border border-line-subtle bg-surface-1 px-4 py-4 sm:px-5">
        <div className="flex items-start justify-between gap-4">
          <dt className="flex min-w-0 flex-col gap-0.5">
            <span className="type-label text-fg">Due today</span>
            <span className="type-body-sm text-fg-muted">
              {reason
                ? reason
                : `${plan ? `${plan.name} plan, ` : ""}${restart ? "one month" : "first month"}${
                    checkout.promotion
                      ? `, with ${checkout.promotion.code} (${promotionAmount(checkout.promotion)} ${promotionReach(checkout.promotion)})`
                      : ""
                  }`}
            </span>
          </dt>
          <dd className="shrink-0 type-label text-fg tabular-nums">
            {due ? formatMoney(due) : <Skeleton className="h-4 w-12" />}
          </dd>
        </div>
        {plan ? (
          <div className="flex items-start justify-between gap-4">
            <dt className="flex min-w-0 flex-col gap-0.5">
              <span className="type-label text-fg">Then</span>
              <span className="type-body-sm text-fg-muted">Every month until you cancel</span>
            </dt>
            <dd className="shrink-0 type-label text-fg tabular-nums">
              {formatMoney(plan.monthlyPrice)}/month
            </dd>
          </div>
        ) : null}
      </dl>
      {config.data && config.data.provider !== "none" && checkout.clientSecret ? (
        <ProviderStep
          config={config.data}
          intent={{ kind: "payment", clientSecret: checkout.clientSecret }}
          returnPath={selfPath}
          submitLabel={due ? `Pay ${formatMoney(due)}` : "Pay now"}
          onHandOff={onHandOff}
          onConfirmed={onPaidInPlace}
        />
      ) : null}
      <p className="type-body-sm text-fg-subtle">
        Prefer another plan?{" "}
        <HrefLink
          href={planHref}
          className="focus-ring rounded-xs font-semibold text-fg underline underline-offset-2"
        >
          Choose a different plan
        </HrefLink>
      </p>
    </section>
  );
}

/** The moment after success: what the member has now, and what happens next. */
function Welcome({
  checkout,
  next,
}: {
  checkout: Checkout;
  next: { label: string; onContinue: () => void };
}) {
  const membershipView = useMembership();
  const { membership } = membershipView;
  const plans = useQuery(queries.plans());
  const plan = plans.data?.items.find((candidate) => candidate.id === checkout.planId) ?? null;
  const trialEnds = checkout.trial?.endsAt ?? membership.trialEndsAt;
  // The next bill as the provider previews it (exact: discounts and credit included).
  const upcoming = membership.nextInvoice ?? null;
  const code = checkout.promotion?.code ?? null;
  // What was paid and why, and the next payment and why, as Membership will say them.
  const paidReason = describeAmountReason(checkout.amountDue, {
    creditApplied: checkout.creditApplied,
    discount: checkout.discount,
    code,
  });
  const nextCharge = upcoming
    ? describeOutcome(
        membershipOutcome(membershipView, { monthlyPrice: plan?.monthlyPrice ?? null }),
      ).charge
    : null;
  let body: ReactNode;
  if (checkout.trial) {
    body = (
      <>
        <p>
          {upcoming
            ? trialEnds && formatLongDate(trialEnds) === formatLongDate(upcoming.at)
              ? `Watch as much as you like until ${formatLongDate(trialEnds)}. Your first payment, ${formatMoney(upcoming.amount)}, is due that day unless you cancel before then.`
              : `Watch as much as you like${trialEnds ? ` until ${formatLongDate(trialEnds)}` : ""}. Your first payment of ${formatMoney(upcoming.amount)} is on ${formatLongDate(upcoming.at)}, unless you cancel before then.`
            : `Watch as much as you like${trialEnds ? ` until ${formatLongDate(trialEnds)}` : ""}.${plan ? ` After that, Webflix charges ${formatMoney(plan.monthlyPrice)} a month unless you cancel before then.` : ""}`}
        </p>
        {code && checkout.promotionOutcome === "not_applied_trial" ? (
          <p>
            Your code {code} wasn't used, because the free trial costs nothing: it's still yours.
          </p>
        ) : null}
        <p>You can cancel anytime in Account.</p>
      </>
    );
  } else {
    body = (
      <>
        <p>
          {checkout.amountDue ? `You paid ${formatMoney(checkout.amountDue)} today` : "Paid"}
          {paidReason ? ` (${paidReason})` : ""}
          {code && checkout.promotionOutcome === "applied" && !checkout.discount
            ? `, with your code ${code}.`
            : "."}
        </p>
        {nextCharge ? (
          <p>{nextCharge}</p>
        ) : membership.currentPeriodEnd ? (
          <p>Your membership renews on {formatLongDate(membership.currentPeriodEnd)}.</p>
        ) : null}
      </>
    );
  }
  return (
    <StatusPanel
      stateKey="complete"
      icon={CheckCircleIcon}
      tone="positive"
      title={checkout.trial ? "Your free trial has started" : "Payment confirmed"}
      actions={
        <Button variant="accent" size="lg" onClick={next.onContinue}>
          {next.label}
        </Button>
      }
    >
      {body}
    </StatusPanel>
  );
}
