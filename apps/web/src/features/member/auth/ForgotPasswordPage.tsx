import { useMutation } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ApiError, PASSWORD_RESET_TTL_SEC } from "@webflix/contracts";
import { Button, MailIcon, TextField, useCanHover } from "@webflix/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { useSession } from "../../../app/session/session.ts";
import { AuthBackdrop } from "../shared/AuthBackdrop.tsx";
import { MemberFooter, MemberHeader } from "../shared/Chrome.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatCountdown } from "../shared/format.ts";
import { useFocusOnError } from "../shared/useFocusOnError.ts";
import { useCountdown, useRetryAfter } from "../shared/useRetryAfter.ts";
import { normalizeEmail, validateEmail } from "../shared/validation.ts";

const route = getRouteApi("/public/forgot-password");

/** A member who asks again within this long is asked to check the first email first. */
const RESEND_AFTER_MS = 30_000;

/**
 * Ask for a password reset link. The answer is the same whether or not the address has an
 * account (the server always answers 204 and looks the address up later, in a job), and so is
 * this page: "if an account uses this address, a link is on its way". It also sets a first
 * password for an account created with Google or Apple.
 */
export function ForgotPasswordPage() {
  const search = route.useSearch();
  const session = useSession();
  const canHover = useCanHover();
  const known = session.authenticated ? session.account.email : undefined;
  const [email, setEmail] = useState(search.email ?? known ?? "");
  const [checked, setChecked] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const resendIn = useCountdown(resendAt);
  const emailRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const sentRef = useRef<HTMLHeadingElement>(null);
  const rate = useRetryAfter();

  const request = useMutation({
    mutationFn: (address: string) => api().requestPasswordReset({ body: { email: address } }),
    meta: { silent: true },
    onError: rate.track,
    onSuccess: (_data, address) => {
      setSentTo(address);
      setResendAt(Date.now() + RESEND_AFTER_MS);
    },
  });
  useFocusOnError(request.error, () => alertRef);
  useEffect(() => {
    if (sentTo) sentRef.current?.focus();
  }, [sentTo]);

  const emailError = checked ? validateEmail(email) : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (request.isPending || rate.limited) return;
    if (validateEmail(email)) return emailRef.current?.focus();
    request.mutate(normalizeEmail(email));
  };

  const minutes = Math.round(PASSWORD_RESET_TTL_SEC / 60);
  const failure = request.error;

  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas">
      <AuthBackdrop />
      <MemberHeader />
      <main
        id="main"
        className="relative z-(--z-raised) flex flex-1 justify-center px-gutter pb-16 pt-4 sm:pt-10"
      >
        <div className="flex w-full max-w-form flex-col gap-4 md:self-start md:rounded-2xl md:border md:border-line-subtle md:bg-canvas/85 md:p-12 md:shadow-xl md:backdrop-blur-md">
          {sentTo ? (
            <section aria-labelledby="sent-heading" className="flex flex-col gap-4">
              <span className="grid size-14 place-items-center rounded-full bg-surface-3 text-fg">
                <MailIcon size="xl" />
              </span>
              <h1
                id="sent-heading"
                ref={sentRef}
                tabIndex={-1}
                className="type-headline text-fg outline-none"
              >
                Check your email
              </h1>
              <p className="type-body-lg text-fg-muted">
                If a Webflix account uses <span className="wrap-anywhere text-fg">{sentTo}</span>,
                we've sent it a link to choose a new password. The link works once and expires in{" "}
                {minutes} minutes.
              </p>
              <p className="type-body text-fg-muted">
                Didn't get it? Check your spam folder, and that the address is the one you sign in
                with.
              </p>
              {failure ? (
                <FormAlert ref={alertRef} title={describeError(failure).title}>
                  {ApiError.is(failure, "rate_limited")
                    ? "For your security, please wait a moment before asking again."
                    : describeError(failure).description}
                </FormAlert>
              ) : null}
              <div className="mt-2 flex flex-col gap-3">
                <Button
                  variant="outline"
                  size="lg"
                  fullWidth
                  loading={request.isPending}
                  disabled={resendIn > 0 || rate.limited}
                  onClick={() => request.mutate(sentTo)}
                >
                  {rate.limited
                    ? `Send again in ${formatCountdown(rate.waiting)}`
                    : resendIn > 0
                      ? `Send again in ${formatCountdown(resendIn)}`
                      : "Send the link again"}
                </Button>
                <Button
                  variant="ghost"
                  size="lg"
                  fullWidth
                  onClick={() => {
                    setSentTo(null);
                    request.reset();
                    window.setTimeout(() => emailRef.current?.focus(), 0);
                  }}
                >
                  Use a different email
                </Button>
              </div>
              <BackLink signedIn={session.authenticated} />
            </section>
          ) : (
            <form
              onSubmit={submit}
              noValidate
              aria-labelledby="forgot-heading"
              className="flex flex-col gap-4"
            >
              <h1 id="forgot-heading" className="type-headline mb-1 text-fg">
                Reset your password
              </h1>
              <p className="type-body text-fg-muted">
                Enter the email address you sign in with, and we'll email you a link to choose a new
                password. Signed up with Google or Apple? The link sets a password for your account
                too.
              </p>
              {failure ? (
                <FormAlert ref={alertRef} title={describeError(failure).title}>
                  {ApiError.is(failure, "rate_limited")
                    ? rate.limited
                      ? "For your security, please wait a moment. The button shows when you can try again."
                      : "You can try again now."
                    : describeError(failure).description}
                </FormAlert>
              ) : null}
              <TextField
                ref={emailRef}
                label="Email address"
                type="email"
                name="email"
                autoComplete="username"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus={canHover}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                error={emailError}
              />
              <Button
                type="submit"
                variant="accent"
                size="lg"
                fullWidth
                loading={request.isPending}
                disabled={rate.limited}
                className="mt-2"
              >
                {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Email me a link"}
              </Button>
              <BackLink signedIn={session.authenticated} />
            </form>
          )}
        </div>
      </main>
      <MemberFooter />
    </div>
  );
}

function BackLink({ signedIn }: { signedIn: boolean }) {
  return (
    <p className="mt-4 type-body text-fg-muted">
      {signedIn ? (
        <Link
          to="/account/security"
          className="focus-ring rounded-xs font-semibold text-fg hover:underline"
        >
          Back to Account
        </Link>
      ) : (
        <>
          Remembered it?{" "}
          <Link
            to="/login"
            search={{}}
            className="focus-ring rounded-xs font-semibold text-fg hover:underline"
          >
            Sign in
          </Link>
        </>
      )}
    </p>
  );
}
