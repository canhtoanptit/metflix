import { useQuery } from "@tanstack/react-query";
import { ApiError, type Checkout, type Money, type Plan, type PlanId } from "@webflix/contracts";
import {
  Button,
  CheckCircleIcon,
  cx,
  ErrorState,
  InfoIcon,
  Skeleton,
  TextField,
} from "@webflix/ui";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { useAuthenticatedSession } from "../../../app/session/session.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { describeQuality, formatMoney, formatScreens } from "../shared/format.ts";
import { markHandedOff } from "./checkoutMemory.ts";
import {
  type DeclineReason,
  describeDecline,
  describePromotionFailure,
  promotionAmount,
  promotionReach,
} from "./copy.ts";
import { DeletionScheduledNotice, useScheduledDeletion } from "./deletion.tsx";
import { NoProviderNotice } from "./NoProviderNotice.tsx";
import { describeAmountReason } from "./outcome.ts";
import { ProviderStep, useBillingConfig } from "./ProviderStep.tsx";
import { describeTooMany } from "./retryAfter.ts";
import {
  type AppliedCode,
  CodeStepError,
  type DroppedCode,
  useCheckoutStart,
} from "./useCheckoutStart.ts";

export interface CheckoutPaymentProps {
  planId: PlanId;
  /** A link back to the plan choice. */
  changePlan: ReactNode;
  /** Where the provider returns to: the confirming state of this checkout. */
  confirmPath: (checkoutId: string) => string;
  /** Go to the confirming state (the card is confirmed, or the checkout is past it). */
  onConfirming: (checkoutId: string, confirmedInPlace: boolean) => void;
  /** The account already has a membership (or one that recovers with a new card). */
  onConflict: () => void;
  /**
   * `restart`: an ended membership, whose trial (one per account) is most likely spent, so the
   * payment today leads; `signup`: a new member, whose trial most likely applies.
   */
  context?: "signup" | "restart";
  /** A card was just declined at the confirming state: say so here (UX review 2.13). */
  declinedBefore?: DeclineReason | "unknown" | null;
}

/**
 * The payment step of a checkout (sign-up, or restarting an ended membership): what the member
 * will pay and when, an optional promo code quoted before anything is charged, and the
 * provider's own form, which is where the card goes. Webflix's page has no card field.
 */
export function CheckoutPayment({
  planId,
  changePlan,
  confirmPath,
  onConfirming,
  onConflict,
  context = "signup",
  declinedBefore = null,
}: CheckoutPaymentProps) {
  const session = useAuthenticatedSession();
  const config = useBillingConfig();
  const plans = useQuery(queries.plans());
  const plan = plans.data?.items.find((candidate) => candidate.id === planId) ?? null;
  const providerReady = config.data !== undefined && config.data.provider !== "none";
  const checkout = useCheckoutStart(session.account.id, planId, providerReady);
  const declineRef = useRef<HTMLDivElement>(null);
  const { state } = checkout;
  const deletion = useScheduledDeletion(state.kind === "deletion");

  useEffect(() => {
    if (state.kind === "confirming") onConfirming(state.checkoutId, false);
    if (state.kind === "conflict") onConflict();
  }, [state, onConfirming, onConflict]);

  const declinedReason = checkout.declined ?? declinedBefore;
  useEffect(() => {
    if (declinedReason) declineRef.current?.focus();
  }, [declinedReason]);

  if (config.data?.provider === "none") return <NoProviderNotice />;
  if (state.kind === "deletion")
    return <DeletionScheduledNotice scheduledFor={deletion?.scheduledFor} />;
  if (config.isError || plans.isError) {
    const error = config.error ?? plans.error;
    return (
      <ErrorState
        layout="inline"
        title="We couldn't load the payment step"
        description={describeError(error).description}
        reference={describeError(error).reference}
        action={
          <Button
            variant="accent"
            onClick={() => {
              void config.refetch();
              void plans.refetch();
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }
  if (state.kind === "error") {
    const described = describeError(state.error);
    return (
      <ErrorState
        layout="inline"
        title="We couldn't get your payment ready"
        description={described.description}
        reference={described.reference}
        action={
          <Button variant="accent" onClick={checkout.retry}>
            Try again
          </Button>
        }
      />
    );
  }

  const decline = declinedReason
    ? describeDecline(declinedReason === "unknown" ? null : declinedReason)
    : null;
  const provider = config.data;
  // The server says whether this account can still have a trial (an older API doesn't: then
  // sign-up assumes one and a restart assumes none, and the words say "if").
  const trial: Trial =
    plan?.trial && checkout.trialEligible !== false
      ? checkout.trialEligible === true
        ? { days: plan.trial.days, certain: true }
        : context === "signup"
          ? { days: plan.trial.days, certain: false }
          : null
      : null;
  const ready = state.kind === "ready" ? state.checkout : null;

  return (
    <div className="flex flex-col gap-6">
      {decline ? (
        <FormAlert ref={declineRef} title={decline.title}>
          {decline.body} Nothing was charged.
        </FormAlert>
      ) : null}
      <CostSummary
        plan={plan}
        applied={checkout.applied}
        changePlan={changePlan}
        trial={trial}
        checkout={ready}
        mayStillHaveTrial={checkout.trialEligible === null && context === "restart"}
      />
      <PromoCode
        applied={checkout.applied}
        dropped={checkout.dropped}
        trial={trial}
        disabled={state.kind !== "ready"}
        onApply={checkout.applyCode}
        onRemove={checkout.removeCode}
      />
      {state.kind === "ready" && plan && provider ? (
        <ProviderStep
          config={provider}
          intent={{ kind: "setup", clientSecret: state.checkout.clientSecret }}
          returnPath={confirmPath(state.checkout.id)}
          submitLabel={provider.provider === "stripe" ? "Start membership" : "Continue to payment"}
          onHandOff={() => markHandedOff(session.account.id, state.checkout.id, "setup")}
          onConfirmed={() => onConfirming(state.checkout.id, true)}
          footnote={<FinePrint trial={trial} due={ready?.amountDue ?? null} />}
        />
      ) : (
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-16 w-full" radius="card" />
          <Skeleton className="h-14 w-full" radius="card" />
          <span className="sr-only" role="status">
            Getting your payment ready
          </span>
        </div>
      )}
    </div>
  );
}

/** A free trial this checkout gets: `certain` when the server said the account can have one. */
type Trial = { days: number; certain: boolean } | null;

/**
 * The plan, and what is due today and after: the server's amounts, never computed here. Without a
 * trial the checkout already carries what is due today and why (the account's credit, the code's
 * discount), so the amount is stated once, with its reason (UX review 2.2, 2.6).
 */
function CostSummary({
  plan,
  applied,
  changePlan,
  trial,
  checkout,
  mayStillHaveTrial,
}: {
  plan: Plan | null;
  applied: AppliedCode | null;
  changePlan: ReactNode;
  trial: Trial;
  checkout: Checkout | null;
  /** An older API that doesn't say whether a returning member is due a trial. */
  mayStillHaveTrial: boolean;
}) {
  let today: { amount: ReactNode; detail: string | null };
  if (!plan) {
    today = { amount: <Skeleton className="h-4 w-12" />, detail: null };
  } else if (trial) {
    today = {
      amount: formatMoney({ amountMinor: 0, currency: plan.monthlyPrice.currency }),
      detail: trial.certain
        ? `Your ${trial.days}-day free trial starts today (one per card)`
        : `${trial.days}-day free trial, if you haven't had a Webflix trial before`,
    };
  } else {
    const due = checkout?.amountDue ?? null;
    const reason = describeAmountReason(due, {
      creditApplied: checkout?.creditApplied,
      discount: checkout?.discount,
      code: checkout?.promotion?.code ?? applied?.code,
    });
    today = {
      amount: formatMoney(due ?? applied?.discountedPrice ?? plan.monthlyPrice),
      detail: reason
        ? reason
        : mayStillHaveTrial && plan.trial
          ? `${applied ? `With ${applied.code}. ` : ""}If you're due a free trial, it starts instead and nothing is charged today`
          : applied
            ? `With ${applied.code}`
            : null,
    };
  }
  return (
    <section
      aria-label="Your plan"
      className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle bg-surface-1"
    >
      <div className="flex items-start justify-between gap-4 px-4 py-4 sm:px-5">
        <div className="flex min-w-0 flex-col gap-1">
          {plan ? (
            <>
              <p className="type-title text-fg">{plan.name}</p>
              <p className="type-body-sm text-fg-muted">
                {describeQuality(plan)} · {formatScreens(plan.maxStreams)}
              </p>
            </>
          ) : (
            <>
              <Skeleton className="h-5 w-28" />
              <Skeleton className="mt-1 h-4 w-48" />
            </>
          )}
        </div>
        {changePlan}
      </div>
      <dl className="flex flex-col gap-3 px-4 py-4 sm:px-5">
        <Row term="Due today" detail={today.detail} amount={today.amount} />
        <Row
          term={trial ? "After the trial" : "Then"}
          detail="Every month until you cancel"
          amount={
            plan ? `${formatMoney(plan.monthlyPrice)}/month` : <Skeleton className="h-4 w-20" />
          }
        />
      </dl>
    </section>
  );
}

function Row({
  term,
  detail,
  amount,
}: {
  term: string;
  detail?: string | null;
  amount: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="flex min-w-0 flex-col gap-0.5">
        <span className="type-label text-fg">{term}</span>
        {detail ? <span className="type-body-sm text-fg-muted">{detail}</span> : null}
      </dt>
      <dd className="shrink-0 type-label text-fg tabular-nums">{amount}</dd>
    </div>
  );
}

/** What to tell the member when applying or removing a code failed. */
function describeCodeFailure(failure: unknown): string {
  const step = failure instanceof CodeStepError ? failure.step : "check";
  const error = failure instanceof CodeStepError ? failure.error : failure;
  if (ApiError.is(error, "promotion_code_invalid")) {
    return describePromotionFailure(error.problem.promotionReason);
  }
  // Checking a code spends the promo-code budget; restarting the checkout may have met either.
  return (
    describeTooMany(error, step === "check" ? "codes" : "attempts") ??
    describeError(error).description
  );
}

/** An optional promo code: checked against the plan and quoted before it is applied. */
function PromoCode({
  applied,
  dropped,
  trial,
  disabled,
  onApply,
  onRemove,
}: {
  applied: AppliedCode | null;
  /** A code the checkout carried that this plan can't take: said, not silently lost. */
  dropped: DroppedCode | null;
  /** A free trial costs nothing today: the code is not used (it stays the member's). */
  trial: Trial;
  disabled: boolean;
  onApply: (code: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const apply = async (event: FormEvent) => {
    event.preventDefault();
    const value = code.trim();
    if (busy) return;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
      setError("Enter the code as it was given to you: letters, numbers, - or _.");
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onApply(value);
      setCode("");
      setOpen(false);
    } catch (failure) {
      setError(describeCodeFailure(failure));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setRemoveError(null);
    try {
      await onRemove();
    } catch (failure) {
      setRemoveError(describeCodeFailure(failure));
    } finally {
      setBusy(false);
    }
  };

  if (applied) {
    // With a trial that is certain, the code does nothing today: say that, in the info tone,
    // instead of a green "applied" beside $0.00 (UX review 2.5).
    const unused = trial?.certain === true;
    return (
      <div className="flex flex-col gap-2">
        <div
          className={cx(
            "flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3",
            unused ? "border-line bg-surface-2" : "border-positive/40 bg-positive-subtle",
          )}
        >
          <p className="flex items-center gap-2 type-body-sm text-fg">
            {unused ? (
              <InfoIcon size="sm" className="shrink-0 text-fg-muted" />
            ) : (
              <CheckCircleIcon size="sm" className="shrink-0 text-positive" />
            )}
            {unused ? (
              <span>
                <span className="type-label">{applied.code}</span> stays yours: your free trial
                costs nothing, so the code applies only if this card has had a trial before.
              </span>
            ) : (
              <span>
                <span className="type-label">{applied.code}</span> applied:{" "}
                {promotionAmount(applied.promotion)} {promotionReach(applied.promotion)}
                {trial ? ". With a free trial it isn't used, and stays yours." : "."}
              </span>
            )}
          </p>
          <Button
            variant="ghost"
            size="sm"
            loading={busy}
            disabled={disabled}
            onClick={() => void remove()}
          >
            Remove<span className="sr-only"> promo code</span>
          </Button>
        </div>
        {removeError ? (
          <p role="alert" className="type-body-sm text-danger">
            We couldn't remove {applied.code}: {removeError} It's still applied.
          </p>
        ) : null}
      </div>
    );
  }
  const droppedNotice = dropped ? (
    <p role="status" className="type-body-sm text-fg-muted">
      {dropped.code} isn't used with this plan: {describePromotionFailure(dropped.reason)}
    </p>
  ) : null;
  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        {droppedNotice}
        <div>
          <Button
            variant="link"
            onClick={() => {
              setOpen(true);
              requestAnimationFrame(() => input.current?.focus());
            }}
          >
            Have a promo code?
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form onSubmit={apply} noValidate className="flex items-start gap-3" aria-label="Promo code">
      <TextField
        ref={input}
        label="Promo code"
        name="promo-code"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={64}
        value={code}
        onChange={(event) => {
          setCode(event.target.value);
          setError(null);
        }}
        error={error}
        className="flex-1"
      />
      <Button type="submit" variant="outline" size="lg" loading={busy} disabled={disabled}>
        Apply
      </Button>
    </form>
  );
}

/**
 * What happens around the provider's page. Without a trial it is two visits today (the card is
 * saved, then the payment confirmed), so the first screen says so: no surprise second trip.
 */
function FinePrint({ trial, due }: { trial: Trial; due: Money | null }) {
  return (
    <p className="type-body-sm text-fg-subtle">
      {trial?.certain
        ? "Cancel before the trial ends and nothing is charged. Cancel anytime in Account."
        : trial
          ? "No free trial for this card or account? You'll see what's due today and confirm it before you pay. Cancel anytime in Account."
          : `After your card is saved, you'll come back here and confirm the ${due ? `${formatMoney(due)} ` : ""}payment on the same secure page. Nothing is charged until you do. Cancel anytime in Account.`}
    </p>
  );
}
