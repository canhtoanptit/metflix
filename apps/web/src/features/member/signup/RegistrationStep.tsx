import { useMutation } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ApiError, PASSWORD_MIN_LENGTH } from "@webflix/contracts";
import { ArrowRightIcon, Button, CheckIcon, PasswordField, TextField } from "@webflix/ui";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError, isUnreachable } from "../../../app/query/errors.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { normalizeEmail, validateEmail, validateNewPassword } from "../shared/validation.ts";
import { draftPassword, readDraft, rememberPassword, updateDraft } from "./draft.ts";
import { StepBody, StepHeading } from "./SignupLayout.tsx";

const route = getRouteApi("/public/signup/");

/**
 * Step 1: email and password. Checks the email before moving on, so someone who already has an
 * account is offered sign-in now rather than a failed payment later. Errors appear once a
 * field has been left or the form submitted, then update live as the member fixes them.
 */
export function RegistrationStep() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const [email, setEmail] = useState(() => search.email ?? readDraft().email ?? "");
  const [password, setPassword] = useState(() => draftPassword() ?? "");
  const [checkEmail, setCheckEmail] = useState(false);
  const [checkPassword, setCheckPassword] = useState(false);
  const [registered, setRegistered] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const proceed = (address: string) => {
    const draft = updateDraft({ email: address, ...(search.plan ? { planId: search.plan } : {}) });
    rememberPassword(password);
    void navigate({ to: "/signup/plan", search: { plan: draft.planId ?? undefined } });
  };

  const lookup = useMutation({
    mutationFn: (address: string) => api().getEmailStatus({ query: { email: address } }),
    meta: { silent: true },
    onSuccess: ({ next }, address) => {
      if (next === "login") {
        setRegistered(address);
        emailRef.current?.focus();
        return;
      }
      proceed(address);
    },
    onError: (error, address) => {
      // The lookup is a courtesy: if it is rate limited, the server checks again at payment.
      if (ApiError.is(error, "rate_limited")) proceed(address);
    },
  });

  const normalized = normalizeEmail(email);
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
    if (lookup.isPending) return;
    if (validateEmail(email) || registered === normalized) return emailRef.current?.focus();
    if (validateNewPassword(password)) return passwordRef.current?.focus();
    lookup.mutate(normalized);
  };

  const failure =
    lookup.error && !ApiError.is(lookup.error, "rate_limited") ? describeError(lookup.error) : null;

  return (
    <StepBody>
      <StepHeading
        step={1}
        title="Create your account"
        description="A few quick steps and you're watching. You'll use this email and password to sign in."
      />
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-4"
        aria-label="Create your account"
      >
        {failure ? (
          <FormAlert title={failure.title}>
            {isUnreachable(lookup.error)
              ? "We couldn't check your email. Check your connection and try again."
              : failure.description}
          </FormAlert>
        ) : null}
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
          iconAfter={ArrowRightIcon}
          loading={lookup.isPending}
          className="mt-2"
        >
          Continue
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
