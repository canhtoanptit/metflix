import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ApiError } from "@webflix/contracts";
import { Button, PasswordField, Skeleton } from "@webflix/ui";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError, isUnreachable } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { useApplySession } from "../../../app/session/session.ts";
import { cardErrorsFrom, describeDecline } from "../shared/billing.ts";
import { CardFields, type CardFieldsHandle, EMPTY_CARD } from "../shared/CardFields.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatCountdown, formatMoney, formatMonthlyPrice } from "../shared/format.ts";
import { RetryTimer } from "../shared/RetryTimer.tsx";
import { TestCardsNote } from "../shared/TestCardsNote.tsx";
import { useFocusOnError } from "../shared/useFocusOnError.ts";
import { useRetryAfter } from "../shared/useRetryAfter.ts";
import { useSingleFlight } from "../shared/useSingleFlight.ts";
import { type CardFormErrors, toCardPayment, validateNewPassword } from "../shared/validation.ts";
import { clearDraft, draftPassword, readDraft, rememberPassword } from "./draft.ts";
import { StepBody, StepHeading } from "./SignupLayout.tsx";

const route = getRouteApi("/public/signup/payment");

/**
 * Step 3: the card, and the moment the account is created (`POST /auth/signup`). A declined
 * card keeps everything the member typed except the security code and says what to do next;
 * nothing is created until the payment is approved, so retrying is always safe. The request is
 * built from component state at submit time (never stored as mutation variables), and a second
 * submit while one is in flight is ignored.
 */
export function PaymentStep() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const applySession = useApplySession();
  const plans = useQuery(queries.plans());
  const [card, setCard] = useState(EMPTY_CARD);
  const [serverErrors, setServerErrors] = useState<CardFormErrors>({});
  const [needsPassword] = useState(() => draftPassword() === null);
  const [password, setPassword] = useState("");
  const [checkPassword, setCheckPassword] = useState(false);
  const cardRef = useRef<CardFieldsHandle>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const rate = useRetryAfter();
  const flight = useSingleFlight();

  const draft = readDraft();
  const email = draft.email ?? "";
  const planId = search.plan ?? draft.planId;
  const plan = plans.data?.items.find((candidate) => candidate.id === planId) ?? null;

  const signup = useMutation({
    mutationFn: () => {
      if (!planId) throw new Error("No plan selected");
      return api().signup({
        body: {
          email,
          password: draftPassword() ?? password,
          planId,
          payment: toCardPayment(card),
        },
      });
    },
    meta: { silent: true },
    onError: (error) => {
      rate.track(error);
      setServerErrors(cardErrorsFrom(error));
    },
    onSuccess: async (session) => {
      clearDraft();
      await applySession(session);
      await navigate({ to: "/signup/profile", replace: true });
    },
  });

  // A declined card puts the member back on the field to fix; anything else on the alert.
  useFocusOnError(signup.error, (error) =>
    ApiError.is(error, "payment_declined")
      ? () => cardRef.current?.focus(describeDecline(error.problem.declineReason).field)
      : alertRef,
  );

  const updateCard = (next: typeof card) => {
    setCard(next);
    // A server verdict is about the card that was sent; editing that field clears it.
    setServerErrors((current) => {
      const remaining = { ...current };
      for (const field of Object.keys(current) as Array<keyof typeof card>) {
        if (next[field] !== card[field]) delete remaining[field];
      }
      return remaining;
    });
  };

  const passwordError = needsPassword && checkPassword ? validateNewPassword(password) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (flight.isBusy() || signup.isSuccess || rate.limited) return;
    setCheckPassword(true);
    if (needsPassword && validateNewPassword(password)) {
      passwordRef.current?.focus();
      return;
    }
    if (!cardRef.current?.validate()) return;
    if (needsPassword) rememberPassword(password);
    flight.run(() => signup.mutateAsync());
  };

  const error = signup.error;
  const alert = !error ? null : ApiError.is(error, "payment_declined") ? (
    <FormAlert ref={alertRef} title={describeDecline(error.problem.declineReason).title}>
      {describeDecline(error.problem.declineReason).body} You haven't been charged.
    </FormAlert>
  ) : ApiError.is(error, "email_already_registered") ? (
    <FormAlert
      ref={alertRef}
      title="This email already has an account"
      action={
        <>
          <Link
            to="/login"
            search={{ email }}
            className="focus-ring rounded-xs type-label text-fg underline underline-offset-2"
          >
            Sign in
          </Link>
          <Link
            to="/signup"
            search={{}}
            className="focus-ring rounded-xs type-label text-fg underline underline-offset-2"
          >
            Use a different email
          </Link>
        </>
      }
    >
      Nothing was charged. Sign in to that account, or start again with another email.
    </FormAlert>
  ) : ApiError.is(error, "rate_limited") ? (
    <FormAlert ref={alertRef} title="Too many attempts">
      {rate.limited ? (
        <>
          Please wait <RetryTimer seconds={rate.waiting} /> and try again.
        </>
      ) : (
        "You can try again now."
      )}
    </FormAlert>
  ) : ApiError.is(error, "validation_failed") ? (
    <FormAlert ref={alertRef} title="Some details need another look">
      Check the highlighted fields and try again.
    </FormAlert>
  ) : (
    <FormAlert ref={alertRef} title={describeError(error).title}>
      {isUnreachable(error)
        ? "We couldn't reach Webflix to start your membership. Check your connection and try again."
        : describeError(error).description}
    </FormAlert>
  );

  return (
    <StepBody>
      <StepHeading
        step={3}
        title="Set up your payment"
        description="Your membership starts as soon as you confirm. No commitments: cancel online anytime."
      />
      <dl className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle bg-surface-1">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3.5">
          <dt className="type-caption text-fg-subtle">Plan</dt>
          <dd className="col-start-1 type-label text-fg">
            {plan ? (
              `${plan.name} · ${formatMonthlyPrice(plan)}`
            ) : plans.isPending ? (
              <Skeleton className="mt-1 h-4 w-40" />
            ) : (
              "Choose a plan"
            )}
          </dd>
          <dd className="col-start-2 row-span-2 row-start-1">
            <Link
              to="/signup/plan"
              search={{ plan: planId ?? undefined }}
              className="focus-ring rounded-xs type-label text-accent hover:underline"
            >
              Change<span className="sr-only"> plan</span>
            </Link>
          </dd>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3.5">
          <dt className="type-caption text-fg-subtle">Email</dt>
          <dd className="col-start-1 truncate type-label text-fg">{email}</dd>
          <dd className="col-start-2 row-span-2 row-start-1">
            <Link
              to="/signup"
              search={{}}
              className="focus-ring rounded-xs type-label text-accent hover:underline"
            >
              Change<span className="sr-only"> email</span>
            </Link>
          </dd>
        </div>
      </dl>

      <form onSubmit={submit} noValidate className="flex flex-col gap-5" aria-label="Payment">
        {alert}
        {needsPassword ? (
          <div className="flex flex-col gap-3">
            <p className="type-body-sm text-fg-muted">
              For your security, your password isn't kept when the page reloads. Enter the password
              you chose for <span className="text-fg">{email}</span> again.
            </p>
            <PasswordField
              ref={passwordRef}
              label="Password"
              name="new-password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onBlur={() => password && setCheckPassword(true)}
              error={passwordError}
            />
          </div>
        ) : null}
        <h2 className="type-title text-fg">Credit or debit card</h2>
        <CardFields
          ref={cardRef}
          value={card}
          onChange={updateCard}
          serverErrors={serverErrors}
          disabled={signup.isPending}
        />
        <p className="type-body-sm text-fg-subtle">
          By selecting <span className="text-fg-muted">Start membership</span>, you agree that
          Webflix will charge {plan ? formatMoney(plan.monthlyPrice) : "your plan's price"} to this
          card today and every month after that until you cancel. Cancel anytime in your Account to
          stop future charges.
        </p>
        <Button
          type="submit"
          variant="accent"
          size="lg"
          fullWidth
          loading={signup.isPending || signup.isSuccess}
          disabled={rate.limited || !plan}
        >
          {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Start membership"}
        </Button>
        <TestCardsNote />
      </form>
    </StepBody>
  );
}
