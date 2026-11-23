import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ApiError, type LoginBody } from "@webflix/contracts";
import { Button, Checkbox, PasswordField, TextField, useCanHover } from "@webflix/ui";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { useApplySession } from "../../../app/session/session.ts";
import { discardPendingEvents } from "../../../app/telemetry/index.ts";
import { AuthBackdrop } from "../shared/AuthBackdrop.tsx";
import { MemberFooter, MemberHeader } from "../shared/Chrome.tsx";
import { deletedAsAsked, forgetDeletionOnSignIn } from "../shared/deletionMemory.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatCountdown, formatLongDate } from "../shared/format.ts";
import { useFocusOnError } from "../shared/useFocusOnError.ts";
import { useRetryAfter } from "../shared/useRetryAfter.ts";
import { useSingleFlight } from "../shared/useSingleFlight.ts";
import { normalizeEmail, validateCurrentPassword, validateEmail } from "../shared/validation.ts";
import {
  FederatedButtons,
  FederatedOutcomeNotice,
  useOutcomeFromUrl,
} from "./FederatedButtons.tsx";
import { linkOfferPath, pendingLinkIntent } from "./linkIntent.ts";
import {
  afterSignInPath,
  federatedStartUrl,
  signInReturnPath,
  useAuthChangeElsewhere,
} from "./oidc.ts";

const route = getRouteApi("/guest/login");

/** How often a tab coming back into view asks whether it was signed in elsewhere. */
const RECHECK_MS = 2_000;

/**
 * Sign in, with a password or with a provider ("Continue with Google / Apple"). Validates on
 * submit (then live), keeps the member's input on every failure, shows a visible retry timer when
 * rate limited, and continues to `?redirect=` (same-origin paths only), Who's watching?, or the
 * sign-up funnel when the account has not finished signing up. A provider attempt that came back
 * signed out (cancelled, failed, an existing account that must sign in first) is explained at the
 * top. A sign-in finished in another tab moves this one on as well.
 */
export function LoginPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const applySession = useApplySession();
  const canHover = useCanHover();
  const returned = useOutcomeFromUrl();
  const providers = useQuery(queries.signInProviders());
  const [email, setEmail] = useState(search.email ?? "");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const rate = useRetryAfter();
  const flight = useSingleFlight();
  // This browser asked for its account's deletion, and the day has passed (nothing identifying).
  const [deletedOn] = useState(() => deletedAsAsked());

  const login = useMutation({
    mutationFn: (body: LoginBody) => {
      // Events queued while signed out must not reach the server as the member about to sign
      // in (the shared-device case): drop them before the session changes.
      discardPendingEvents();
      return api().login({ body });
    },
    meta: { silent: true },
    onError: (error) => {
      rate.track(error);
      if (ApiError.is(error, "invalid_credentials")) {
        setPassword("");
        setSubmitted(false);
      }
    },
    onSuccess: async (session, body) => {
      forgetDeletionOnSignIn();
      await applySession(session);
      // Signed in to add a provider (`link-required`): the password just typed is also the
      // account-holder proof, so the offer on Security needs one click, not the password again.
      const linking = pendingLinkIntent();
      if (linking) {
        await api()
          .elevate({ body: { password: body.password } })
          .catch(() => {
            // The offer asks for the proof itself if this did not take.
          });
        await navigate({ href: linkOfferPath(linking), replace: true });
        return;
      }
      await navigate({ href: afterSignInPath(session, search.redirect), replace: true });
    },
  });

  // Signed in from another tab (a provider's callback can land in any tab): continue here too.
  const lastCheck = useRef(0);
  useAuthChangeElsewhere((change) => {
    // Another tab signed this browser in: what this tab queued while signed out would be sent
    // with the new session's cookie, as the member. Drop it first.
    if (change === "signed-in") discardPendingEvents();
    if (change === "shown" && Date.now() - lastCheck.current < RECHECK_MS) return;
    lastCheck.current = Date.now();
    void queryClient
      .fetchQuery({ ...queries.session(), staleTime: 0 })
      .then(async (session) => {
        if (!session.authenticated) return;
        await applySession(session);
        await navigate({ href: afterSignInPath(session, search.redirect), replace: true });
      })
      .catch(() => {});
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

  const typedEmail = normalizeEmail(email) || undefined;
  const error = login.error;
  const alert = error ? (
    ApiError.is(error, "invalid_credentials") ? (
      <FormAlert ref={alertRef} title="Incorrect email or password">
        {deletedOn ? (
          <>
            If you meant the account deleted on {formatLongDate(deletedOn)}, it no longer exists:{" "}
            <Link
              to="/signup"
              search={{ email: typedEmail }}
              className="focus-ring rounded-xs font-semibold text-fg underline underline-offset-2"
            >
              create a new account
            </Link>{" "}
            to watch again. Otherwise, check them and try again.
          </>
        ) : (
          <>
            Check them and try again.{" "}
            <Link
              to="/forgot-password"
              search={{ email: typedEmail }}
              className="focus-ring rounded-xs font-semibold text-fg underline underline-offset-2"
            >
              Reset your password
            </Link>{" "}
            or{" "}
            <Link
              to="/signup"
              search={{ email: typedEmail }}
              className="focus-ring rounded-xs font-semibold text-fg underline underline-offset-2"
            >
              create an account
            </Link>
            .
          </>
        )}
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
        <div className="flex w-full max-w-form flex-col gap-4 md:self-start md:rounded-2xl md:border md:border-line-subtle md:bg-canvas/85 md:p-12 md:shadow-xl md:backdrop-blur-md">
          <h1 id="sign-in-heading" className="type-card-headline mb-2 text-fg">
            Sign in
          </h1>
          {deletedOn && !returned && !error ? (
            <FormAlert tone="info" title="Your account has been deleted">
              You asked for it on this browser, and it was deleted on {formatLongDate(deletedOn)}.
              To watch again, create a new account: the same email address works.
            </FormAlert>
          ) : null}
          {returned && !error ? (
            <FederatedOutcomeNotice
              outcome={returned.outcome}
              error={returned.error}
              provider={returned.provider}
              context="signin"
              offered={providers.data?.items}
              retryHref={(provider) =>
                federatedStartUrl(
                  provider,
                  "signin",
                  signInReturnPath({
                    provider,
                    context: "signin",
                    from: "/login",
                    redirect: search.redirect,
                  }),
                )
              }
            />
          ) : null}
          <form
            onSubmit={submit}
            noValidate
            aria-labelledby="sign-in-heading"
            className="flex flex-col gap-4"
          >
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
              autoFocus={canHover && !search.email && !returned}
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
              autoFocus={canHover && Boolean(search.email) && !returned}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={passwordError}
            />
            <Link
              to="/forgot-password"
              search={{ email: typedEmail }}
              className="focus-ring -mt-1 inline-flex min-h-6 items-center self-end rounded-xs type-label text-fg-muted underline-offset-2 hover:text-fg hover:underline"
            >
              Forgot password?
            </Link>
            <Button
              type="submit"
              variant="accent"
              size="lg"
              fullWidth
              loading={login.isPending}
              disabled={rate.limited}
            >
              {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Sign in"}
            </Button>
            <Checkbox
              label="Remember me"
              description="Stay signed in on this device for 30 days."
              checked={rememberMe}
              onCheckedChange={setRememberMe}
            />
          </form>
          <FederatedButtons
            context="signin"
            redirect={search.redirect}
            showOutcome={false}
            divider="before"
            className="mt-2"
          />
          <p className="mt-6 type-body text-fg-muted">
            New to Webflix?{" "}
            <Link
              to="/signup"
              search={{ email: typedEmail }}
              className="focus-ring rounded-xs font-semibold text-fg hover:underline"
            >
              Create an account
            </Link>
          </p>
        </div>
      </main>
      <MemberFooter />
    </div>
  );
}
