import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type AccountDetails,
  ApiError,
  type SessionState,
  type UpdateAccountBody,
} from "@webflix/contracts";
import { Button, PasswordField, TextField, toast } from "@webflix/ui";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { qk } from "../../../app/query/keys.ts";
import { useAuthenticatedSession } from "../../../app/session/session.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatCountdown } from "../shared/format.ts";
import { describeMemberError, useIsDemoAccount } from "../shared/privileges.ts";
import { useRetryAfter } from "../shared/useRetryAfter.ts";
import {
  normalizeEmail,
  validateCurrentPassword,
  validateEmail,
  validateNewPassword,
} from "../shared/validation.ts";
import { AccountHeading, AccountSection } from "./AccountLayout.tsx";

/** Sign-in details: change email, change password. Both need the current password. */
export function AccountSecurityPage() {
  const demo = useIsDemoAccount();
  return (
    <>
      <AccountHeading
        title="Security"
        description="Your email and password are how you sign in to Webflix on every device."
      />
      {demo ? (
        <FormAlert tone="info" title="The demo account's sign-in details can't be changed">
          Everyone who tries Webflix signs in with them, so they stay as they are.
        </FormAlert>
      ) : (
        <>
          <EmailForm />
          <PasswordForm />
        </>
      )}
    </>
  );
}

function useUpdateAccount(onDone: (details: AccountDetails) => void) {
  const queryClient = useQueryClient();
  const rate = useRetryAfter();
  const mutation = useMutation({
    mutationFn: (body: UpdateAccountBody) => api().updateAccount({ body }),
    meta: { silent: true },
    onError: rate.track,
    onSuccess: (details) => {
      queryClient.setQueryData(qk.account.details(), details);
      const session = queryClient.getQueryData<SessionState>(qk.session());
      if (session?.authenticated) {
        const next: SessionState = { ...session, account: details.account };
        queryClient.setQueryData(qk.session(), next);
      }
      void queryClient.invalidateQueries({ queryKey: qk.account.devices() });
      onDone(details);
    },
  });
  return { mutation, rate };
}

function EmailForm() {
  const session = useAuthenticatedSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [checked, setChecked] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const { mutation, rate } = useUpdateAccount((details) => {
    toast.success("Email updated", {
      description: `Sign in with ${details.account.email} from now on.`,
    });
    setEmail("");
    setPassword("");
    setChecked(false);
  });

  const same = normalizeEmail(email) === session.account.email;
  const emailError = ApiError.is(mutation.error, "email_already_registered")
    ? "Another account already uses this email."
    : checked
      ? (validateEmail(email) ?? (same ? "That's already your email." : null))
      : null;
  const passwordError = ApiError.is(mutation.error, "current_password_invalid")
    ? "That password isn't right."
    : checked
      ? validateCurrentPassword(password)
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (mutation.isPending || rate.limited) return;
    if (validateEmail(email) || same) return emailRef.current?.focus();
    if (validateCurrentPassword(password)) return passwordRef.current?.focus();
    mutation.mutate({ email: normalizeEmail(email), currentPassword: password });
  };

  const other =
    mutation.error &&
    !ApiError.is(mutation.error, "email_already_registered") &&
    !ApiError.is(mutation.error, "current_password_invalid")
      ? mutation.error
      : null;

  return (
    <AccountSection
      title="Email"
      description={
        <>
          You sign in with <span className="text-fg">{session.account.email}</span>.
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label="Change email">
        {other ? (
          <FormAlert
            title={
              ApiError.is(other, "rate_limited")
                ? "Too many attempts"
                : describeMemberError(other).title
            }
          >
            {ApiError.is(other, "rate_limited") ? (
              rate.limited ? (
                <>
                  For your security, please wait a moment. The button shows when you can try again.
                </>
              ) : (
                "You can try again now."
              )
            ) : (
              describeMemberError(other).description
            )}
          </FormAlert>
        ) : null}
        <TextField
          ref={emailRef}
          label="New email address"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (ApiError.is(mutation.error, "email_already_registered")) mutation.reset();
          }}
          error={emailError}
        />
        <PasswordField
          ref={passwordRef}
          label="Current password"
          name="current-password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (ApiError.is(mutation.error, "current_password_invalid")) mutation.reset();
          }}
          error={passwordError}
        />
        <div>
          <Button
            type="submit"
            variant="accent"
            loading={mutation.isPending}
            disabled={rate.limited}
          >
            {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Update email"}
          </Button>
        </div>
      </form>
    </AccountSection>
  );
}

function PasswordForm() {
  const session = useAuthenticatedSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [checked, setChecked] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const { mutation, rate } = useUpdateAccount(() => {
    toast.success("Password changed", {
      description: "Other devices have been signed out. This one stays signed in.",
    });
    setCurrent("");
    setNext("");
    setChecked(false);
  });

  const reused = next.length > 0 && next === current;
  const currentError = ApiError.is(mutation.error, "current_password_invalid")
    ? "That password isn't right."
    : checked
      ? validateCurrentPassword(current)
      : null;
  const nextError = checked
    ? (validateNewPassword(next) ?? (reused ? "Choose a password you haven't used here." : null))
    : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (mutation.isPending || rate.limited) return;
    if (validateCurrentPassword(current)) return currentRef.current?.focus();
    if (validateNewPassword(next) || reused) return nextRef.current?.focus();
    mutation.mutate({ currentPassword: current, newPassword: next });
  };

  const other =
    mutation.error && !ApiError.is(mutation.error, "current_password_invalid")
      ? mutation.error
      : null;

  return (
    <AccountSection
      title="Password"
      description="Changing your password signs out every other device. Anything playing on them stops within about half a minute."
    >
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-4"
        aria-label="Change password"
      >
        {other ? (
          <FormAlert
            title={
              ApiError.is(other, "rate_limited")
                ? "Too many attempts"
                : describeMemberError(other).title
            }
          >
            {ApiError.is(other, "rate_limited") ? (
              rate.limited ? (
                <>
                  For your security, please wait a moment. The button shows when you can try again.
                </>
              ) : (
                "You can try again now."
              )
            ) : (
              describeMemberError(other).description
            )}
          </FormAlert>
        ) : null}
        {/* Lets password managers attach the new password to the right account. */}
        <input
          type="hidden"
          name="username"
          autoComplete="username"
          value={session.account.email}
          readOnly
        />
        <PasswordField
          ref={currentRef}
          label="Current password"
          name="current-password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => {
            setCurrent(event.target.value);
            if (ApiError.is(mutation.error, "current_password_invalid")) mutation.reset();
          }}
          error={currentError}
        />
        <PasswordField
          ref={nextRef}
          label="New password"
          name="new-password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          error={nextError}
          hint="At least 8 characters."
        />
        <div>
          <Button
            type="submit"
            variant="accent"
            loading={mutation.isPending}
            disabled={rate.limited}
          >
            {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Change password"}
          </Button>
        </div>
      </form>
    </AccountSection>
  );
}
