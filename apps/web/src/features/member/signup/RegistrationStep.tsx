import { useMutation } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ApiError, PASSWORD_MIN_LENGTH } from "@webflix/contracts";
import { ArrowRightIcon, Button, CheckIcon, PasswordField, Skeleton, TextField } from "@webflix/ui";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError, isUnreachable } from "../../../app/query/errors.ts";
import { useApplySession } from "../../../app/session/session.ts";
import { discardPendingEvents } from "../../../app/telemetry/index.ts";
import { FederatedButtons } from "../auth/FederatedButtons.tsx";
import { NoProviderNotice } from "../billing/NoProviderNotice.tsx";
import { useBillingConfig } from "../billing/ProviderStep.tsx";
import { forgetDeletionOnSignIn } from "../shared/deletionMemory.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatCountdown } from "../shared/format.ts";
import { useFocusOnError } from "../shared/useFocusOnError.ts";
import { useRetryAfter } from "../shared/useRetryAfter.ts";
import { useSingleFlight } from "../shared/useSingleFlight.ts";
import { normalizeEmail, validateEmail, validateNewPassword } from "../shared/validation.ts";
import { readDraft, updateDraft } from "./draft.ts";
import { StepBody, StepHeading } from "./SignupLayout.tsx";

const route = getRouteApi("/public/signup/");

/**
 * Step 1: create the account (docs/BLUEPRINT-M2.md §5.1), with an email and a password or with
 * Google or Apple. The account exists from here on, without a membership: a member who stops
 * after this step signs in later and carries on with the plan. Errors appear once a field has
 * been left or the form submitted, then update live as the member fixes them.
 */
export function RegistrationStep() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const applySession = useApplySession();
  const config = useBillingConfig();
  const [email, setEmail] = useState(() => search.email ?? readDraft().email ?? "");
  const [password, setPassword] = useState("");
  const [checkEmail, setCheckEmail] = useState(false);
  const [checkPassword, setCheckPassword] = useState(false);
  const [registered, setRegistered] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const rate = useRetryAfter();
  const flight = useSingleFlight();

  const normalized = normalizeEmail(email);
  const signup = useMutation({
    mutationFn: (body: { email: string; password: string }) => {
      // Creating the account signs this browser in: events queued while signed out must not be
      // sent under the new member's session (the window before the client learns of it).
      discardPendingEvents();
      return api().signup({ body });
    },
    meta: { silent: true },
    onError: (error, body) => {
      rate.track(error);
      if (ApiError.is(error, "email_already_registered")) setRegistered(body.email);
    },
    onSuccess: async (session) => {
      forgetDeletionOnSignIn();
      await applySession(session);
      await navigate({ to: "/signup/plan", search: { plan: readDraft().planId ?? undefined } });
    },
  });

  useFocusOnError(signup.error, (error) =>
    ApiError.is(error, "email_already_registered") ? emailRef : alertRef,
  );

  const emailError =
    registered === normalized
      ? "There's already a Webflix account with this email."
      : checkEmail
        ? validateEmail(email)
        : null;
  const passwordError = checkPassword ? validateNewPassword(password) : null;
  const passwordOk = validateNewPassword(password) === null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCheckEmail(true);
    setCheckPassword(true);
    if (flight.isBusy() || signup.isSuccess || rate.limited) return;
    if (validateEmail(email) || registered === normalized) return emailRef.current?.focus();
    if (validateNewPassword(password)) return passwordRef.current?.focus();
    updateDraft({ email: normalized, ...(search.plan ? { planId: search.plan } : {}) });
    flight.run(() => signup.mutateAsync({ email: normalized, password }));
  };

  if (config.data?.provider === "none") {
    return (
      <StepBody>
        <NoProviderNotice
          headingLevel={1}
          action={
            <Button variant="accent" size="lg" asChild>
              <Link to="/login" search={{}}>
                Sign in
              </Link>
            </Button>
          }
        >
          Webflix can't take payments right now, so new memberships can't be started. If you already
          have an account, you can still sign in.
        </NoProviderNotice>
      </StepBody>
    );
  }

  const error = signup.error;
  const failure =
    !error || ApiError.is(error, "email_already_registered") ? null : ApiError.is(
        error,
        "rate_limited",
      ) ? (
      <FormAlert ref={alertRef} title="Too many attempts">
        {rate.limited
          ? "For your security, please wait a moment. The button shows when you can try again."
          : "You can try again now."}
      </FormAlert>
    ) : (
      <FormAlert ref={alertRef} title={describeError(error).title}>
        {isUnreachable(error)
          ? "We couldn't reach Webflix to create your account. Check your connection and try again."
          : ApiError.is(error, "validation_failed")
            ? "Check your email and password and try again."
            : describeError(error).description}
      </FormAlert>
    );

  return (
    <StepBody>
      <StepHeading
        step={1}
        title="Create your account"
        description="Then choose your plan. You'll be watching in a few minutes."
      />
      {config.isPending ? (
        <Skeleton className="h-12 w-full" radius="card" />
      ) : (
        <FederatedButtons context="signup" divider="after" />
      )}
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-4"
        aria-label="Create your account"
      >
        {failure}
        <TextField
          ref={emailRef}
          label="Email address"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onBlur={() => email.trim() && setCheckEmail(true)}
          error={
            emailError ? (
              registered === normalized ? (
                <>
                  {emailError}{" "}
                  <Link
                    to="/login"
                    search={{ email: normalized }}
                    className="focus-ring rounded-xs font-semibold text-fg underline underline-offset-2"
                  >
                    Sign in instead
                  </Link>
                </>
              ) : (
                emailError
              )
            ) : undefined
          }
        />
        <PasswordField
          ref={passwordRef}
          label="Password"
          name="new-password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onBlur={() => password && setCheckPassword(true)}
          error={passwordError}
          hint={
            passwordOk ? (
              <span className="inline-flex items-center gap-1.5 text-positive">
                <CheckIcon size="sm" /> Good to go
              </span>
            ) : (
              `Use at least ${PASSWORD_MIN_LENGTH} characters. A short phrase is easy to remember.`
            )
          }
        />
        <Button
          type="submit"
          variant="accent"
          size="lg"
          fullWidth
          iconAfter={rate.limited ? undefined : ArrowRightIcon}
          loading={signup.isPending || signup.isSuccess}
          disabled={rate.limited}
          className="mt-2"
        >
          {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Create account"}
        </Button>
      </form>
      <p className="type-body text-fg-muted">
        Already a member?{" "}
        <Link
          to="/login"
          search={{ email: normalized || undefined }}
          className="focus-ring rounded-xs font-semibold text-fg hover:underline"
        >
          Sign in
        </Link>
      </p>
    </StepBody>
  );
}
