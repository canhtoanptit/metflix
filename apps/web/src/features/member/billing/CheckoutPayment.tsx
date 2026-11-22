import { useQuery } from "@tanstack/react-query";
import { ApiError, type Plan, type PlanId } from "@webflix/contracts";
import { Button, CheckCircleIcon, ErrorState, Skeleton, TextField } from "@webflix/ui";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { useAuthenticatedSession } from "../../../app/session/session.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { describeQuality, formatMoney, formatScreens } from "../shared/format.ts";
import { markHandedOff } from "./checkoutMemory.ts";
import {
  describeDecline,
  describePromotionFailure,
  promotionAmount,
  promotionReach,
} from "./copy.ts";
import { DeletionScheduledNotice, useScheduledDeletion } from "./deletion.tsx";
import { NoProviderNotice } from "./NoProviderNotice.tsx";
import { ProviderStep, useBillingConfig } from "./ProviderStep.tsx";
import { type AppliedCode, useCheckoutStart } from "./useCheckoutStart.ts";

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

  useEffect(() => {
    if (checkout.declined) declineRef.current?.focus();
  }, [checkout.declined]);

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
            variant="primary"
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
          <Button variant="primary" onClick={checkout.retry}>
            Try again
          </Button>
        }
      />
    );
  }

  const decline = checkout.declined ? describeDecline(checkout.declined) : null;
  const provider = config.data;

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
        trialLikely={context === "signup"}
      />
      <PromoCode
        applied={checkout.applied}
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
          footnote={<FinePrint trialLikely={context === "signup"} />}
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

/** The plan, and what is due today and after: from the server's prices, never computed here. */
function CostSummary({
  plan,
  applied,
  changePlan,
  trialLikely,
}: {
  plan: Plan | null;
  applied: AppliedCode | null;
  changePlan: ReactNode;
  trialLikely: boolean;
}) {
  const offeredTrial = plan?.trial?.days ?? null;
  const trialDays = trialLikely ? offeredTrial : null;
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
        <Row
          term="Due today"
          detail={
            trialDays
              ? `${trialDays}-day free trial, if you haven't had a Webflix trial before`
              : offeredTrial
                ? `${applied ? `With ${applied.code}. ` : ""}If you're due a free trial, it starts instead and nothing is charged today`
                : applied
                  ? `With ${applied.code}`
                  : null
          }
          amount={
            plan ? (
              formatMoney(
                trialDays
                  ? { amountMinor: 0, currency: plan.monthlyPrice.currency }
                  : applied
                    ? applied.quote.discountedPrice
                    : plan.monthlyPrice,
              )
            ) : (
              <Skeleton className="h-4 w-12" />
            )
          }
        />
        <Row
          term={trialDays ? "After the trial" : "Then"}
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

/** An optional promo code: checked against the plan and quoted before it is applied. */
function PromoCode({
  applied,
  disabled,
  onApply,
  onRemove,
}: {
  applied: AppliedCode | null;
  disabled: boolean;
  onApply: (code: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
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
      setError(
        ApiError.is(failure, "promotion_code_invalid")
          ? describePromotionFailure(failure.problem.promotionReason)
          : ApiError.is(failure, "rate_limited")
            ? `Too many codes tried. Try again in ${failure.problem.retryAfterSec} seconds.`
            : describeError(failure).description,
      );
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  if (applied) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-positive/40 bg-positive-subtle px-4 py-3">
        <p className="flex items-center gap-2 type-body-sm text-fg">
          <CheckCircleIcon size="sm" className="text-positive" />
          <span>
            <span className="type-label">{applied.code}</span> applied:{" "}
            {promotionAmount(applied.quote.promotion)} {promotionReach(applied.quote.promotion)} (
            {formatMoney(applied.quote.discountedPrice)} instead of{" "}
            {formatMoney(applied.quote.price)}). With a free trial it isn't used, and stays yours.
          </span>
        </p>
        <Button
          variant="ghost"
          size="sm"
          loading={busy}
          disabled={disabled}
          onClick={async () => {
            setBusy(true);
            try {
              await onRemove();
            } finally {
              setBusy(false);
            }
          }}
        >
          Remove<span className="sr-only"> promo code</span>
        </Button>
      </div>
    );
  }
  if (!open) {
    return (
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

function FinePrint({ trialLikely }: { trialLikely: boolean }) {
  return (
    <p className="type-body-sm text-fg-subtle">
      {trialLikely
        ? "No free trial for this card or account? You'll see what's due today and confirm it before you pay. Cancel anytime in Account."
        : "You'll see what's due today and confirm it before you pay. Cancel anytime in Account."}
    </p>
  );
}
