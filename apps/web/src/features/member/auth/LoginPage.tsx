import { useMutation } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ApiError, type LoginBody } from "@webflix/contracts";
import { Button, Checkbox, PasswordField, TextField, useCanHover } from "@webflix/ui";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { isSafeRedirect } from "../../../app/router/search.ts";
import { useApplySession } from "../../../app/session/session.ts";
import { AuthBackdrop } from "../shared/AuthBackdrop.tsx";
import { MemberFooter, MemberHeader } from "../shared/Chrome.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatCountdown } from "../shared/format.ts";
import { useFocusOnError } from "../shared/useFocusOnError.ts";
import { useRetryAfter } from "../shared/useRetryAfter.ts";
import { useSingleFlight } from "../shared/useSingleFlight.ts";
import { normalizeEmail, validateCurrentPassword, validateEmail } from "../shared/validation.ts";

const route = getRouteApi("/guest/login");

/**
 * Sign in. Validates on submit (then live), keeps the member's input on every failure, shows a
 * visible retry timer when rate limited, and continues to `?redirect=` (validated: same-origin
 * paths only) or the profile gate.
 */
export function LoginPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const applySession = useApplySession();
  const canHover = useCanHover();
  const [email, setEmail] = useState(search.email ?? "");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const rate = useRetryAfter();
  const flight = useSingleFlight();

  const login = useMutation({
    mutationFn: (body: LoginBody) => api().login({ body }),
    meta: { silent: true },
    onError: (error) => {
      rate.track(error);
      if (ApiError.is(error, "invalid_credentials")) {
        setPassword("");
        setSubmitted(false);
      }
    },
    onSuccess: async (session) => {
      await applySession(session);
      const next =
        search.redirect && isSafeRedirect(search.redirect) ? search.redirect : "/profiles";
      await navigate({ href: next, replace: true });
    },
  });

  useFocusOnError(login.error, (error) =>
    ApiError.is(error, "invalid_credentials") ? passwordRef : alertRef,
  );

  const emailError = submitted ? validateEmail(email) : null;
  const passwordError = submitted ? validateCurrentPassword(password) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (flight.isBusy() || rate.limited) return;
    if (validateEmail(email)) return emailRef.current?.focus();
    if (validateCurrentPassword(password)) return passwordRef.current?.focus();
    flight.run(() => login.mutateAsync({ email: normalizeEmail(email), password, rememberMe }));
  };

  const error = login.error;
  const alert = error ? (
    ApiError.is(error, "invalid_credentials") ? (
      <FormAlert ref={alertRef} title="Incorrect email or password">
        Check them and try again.{" "}
        <Link
          to="/signup"
          search={{ email: normalizeEmail(email) || undefined }}
          className="focus-ring rounded-xs font-semibold text-fg underline underline-offset-2"
        >
          New here? Create an account
        </Link>
      </FormAlert>
    ) : ApiError.is(error, "rate_limited") ? (
      <FormAlert ref={alertRef} title="Too many sign-in attempts">
        {rate.limited
          ? "For your security, sign-in is paused for a moment. The button shows when you can try again."
          : "You can try again now."}
      </FormAlert>
    ) : (
      <FormAlert ref={alertRef} title={describeError(error).title}>
        {describeError(error).description}
      </FormAlert>
    )
  ) : null;

  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas">
      <AuthBackdrop />
      <MemberHeader />
      <main
        id="main"
        className="relative z-(--z-raised) flex flex-1 justify-center px-gutter pb-16 pt-4 sm:pt-10"
      >
        <form
          onSubmit={submit}
          noValidate
          aria-labelledby="sign-in-heading"
          className="flex w-full max-w-form flex-col gap-4 md:self-start md:rounded-2xl md:border md:border-line-subtle md:bg-canvas/85 md:p-12 md:shadow-xl md:backdrop-blur-md"
        >
          <h1 id="sign-in-heading" className="type-headline mb-2 text-fg">
            Sign in
          </h1>
          {alert}
          <TextField
            ref={emailRef}
            label="Email address"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus={canHover && !search.email}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={emailError}
          />
          <PasswordField
            ref={passwordRef}
            label="Password"
            name="password"
            autoComplete="current-password"
            autoFocus={canHover && Boolean(search.email)}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={passwordError}
          />
          <Button
            type="submit"
            variant="accent"
            size="lg"
            fullWidth
            loading={login.isPending}
            disabled={rate.limited}
            className="mt-2"
          >
            {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Sign in"}
          </Button>
          <Checkbox
            label="Remember me"
            description="Stay signed in on this device for 30 days."
            checked={rememberMe}
            onCheckedChange={setRememberMe}
          />
          <p className="mt-6 type-body text-fg-muted">
            New to Webflix?{" "}
            <Link
              to="/signup"
              search={{ email: normalizeEmail(email) || undefined }}
              className="focus-ring rounded-xs font-semibold text-fg hover:underline"
            >
              Create an account
            </Link>
          </p>
        </form>
      </main>
      <MemberFooter />
    </div>
  );
}
