import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ApiError } from "@webflix/contracts";
import { Button, CheckCircleIcon, ErrorState, Spinner } from "@webflix/ui";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { useSession } from "../../../app/session/session.ts";
import { DeadLink } from "./DeadLink.tsx";
import { forgetLinkToken, looksLikeLinkToken, useLinkToken } from "./emailLink.ts";
import { afterSignInPath } from "./oidc.ts";
import { CARD_HEADING, EmailText } from "./parts.tsx";
import { Frame } from "./ResetPasswordPage.tsx";

const TOKEN_KEY = "webflix:verify-token";

/**
 * One request per token, however often the page mounts (React's development double mount, a
 * remount): the token is single-use, so a second request would report a dead link for a
 * verification that just worked.
 */
const confirmations = new Map<string, Promise<void>>();

function confirmOnce(token: string): Promise<void> {
  let pending = confirmations.get(token);
  if (!pending) {
    pending = api().confirmEmailVerification({ body: { token } });
    confirmations.set(token, pending);
    // A failure that may pass on a retry (network, server) must not stay cached.
    pending.catch((error: unknown) => {
      if (!ApiError.is(error, "verification_token_invalid")) confirmations.delete(token);
    });
  }
  return pending;
}

/**
 * Whose address the link verified, as far as this page can tell: the account signed in here
 * (it was unverified before and is verified now: the link was its own, opened in its own
 * session), another account than the one signed in here, or nobody signed in at all.
 */
type Whose = "own" | "other" | "signed-out";

type State =
  | { status: "verifying" }
  | { status: "verified"; whose: Whose }
  | { status: "invalid" }
  | { status: "error"; error: unknown };

/**
 * The emailed verification link. It verifies as soon as it opens (there is nothing to decide),
 * in any browser, signed in or not. What it says afterwards depends on whose session it was
 * opened in (security review H1): only a link opened in its own account's signed-in session lets
 * Google or Apple sign in to that account by themselves, so only then is that said. Opened signed
 * out, it says how to add them, and offers the reset to someone who never made the account;
 * opened in another account's session, it says the link was for another account. A link already
 * used by the signed-in account, whose address is verified, says so instead of calling it dead.
 */
export function VerifyEmailPage() {
  const token = useLinkToken(TOKEN_KEY);
  const session = useSession();
  const queryClient = useQueryClient();
  const valid = looksLikeLinkToken(token);
  const [state, setState] = useState<State>(() =>
    valid ? { status: "verifying" } : { status: "invalid" },
  );
  const [attempt, setAttempt] = useState(0);
  // Who was signed in here when the link opened (the session may change underneath later).
  const [before] = useState(() =>
    session.authenticated
      ? { id: session.account.id, verified: session.account.emailVerified === true }
      : null,
  );

  useEffect(() => {
    if (!valid) return;
    let current = true;
    setState({ status: "verifying" });
    confirmOnce(token)
      .then(async () => {
        forgetLinkToken(TOKEN_KEY);
        let whose: Whose = "signed-out";
        if (before) {
          const after = await queryClient
            .fetchQuery({ ...queries.session(), staleTime: 0 })
            .catch(() => null);
          whose =
            !before.verified &&
            after?.authenticated &&
            after.account.id === before.id &&
            after.account.emailVerified === true
              ? "own"
              : "other";
        }
        if (current) setState({ status: "verified", whose });
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (ApiError.is(error, "verification_token_invalid")) {
          forgetLinkToken(TOKEN_KEY);
          setState({ status: "invalid" });
        } else {
          setState({ status: "error", error });
        }
      });
    return () => {
      current = false;
    };
    // `attempt` re-runs the request after a failure the member retries.
  }, [token, valid, queryClient, attempt, before]);

  const alreadyVerified =
    state.status === "invalid" && session.authenticated && session.account.emailVerified === true;

  return (
    <Frame>
      {state.status === "verifying" ? (
        <div className="grid min-h-60 place-items-center" aria-live="polite">
          <Spinner size="lg" label="Verifying your email" />
        </div>
      ) : state.status === "verified" ? (
        <Verified whose={state.whose} />
      ) : alreadyVerified ? (
        <Verified whose="already" />
      ) : state.status === "invalid" ? (
        <DeadLink kind="verify" />
      ) : (
        <ErrorState
          title="We couldn't verify your email just now"
          description={describeError(state.error).description}
          action={
            <Button variant="primary" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </Button>
          }
        />
      )}
    </Frame>
  );
}

function Verified({ whose }: { whose: Whose | "already" }) {
  const session = useSession();
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const next = session.authenticated
    ? session.activeProfile
      ? "/browse"
      : afterSignInPath(session, undefined)
    : null;
  const email = session.authenticated ? session.account.email : null;
  const title =
    whose === "own"
      ? "Your email is verified"
      : whose === "already"
        ? "Your email is already verified"
        : whose === "other"
          ? "That email address is verified"
          : "The email address is verified";
  const continueButton = next ? (
    <Button variant="accent" size="lg" fullWidth asChild>
      <a
        href={next}
        onClick={(event) => {
          event.preventDefault();
          void navigate({ href: next });
        }}
      >
        Continue to Webflix
      </a>
    </Button>
  ) : null;
  const resetLink = (
    <Link
      to="/forgot-password"
      className="focus-ring rounded-xs font-semibold text-fg underline underline-offset-2"
    >
      Reset its password
    </Link>
  );
  return (
    <section aria-labelledby="verified" className="flex flex-col items-center gap-5 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-positive-subtle text-positive">
        <CheckCircleIcon size="xl" />
      </span>
      <h1 id="verified" ref={headingRef} tabIndex={-1} className={`${CARD_HEADING} outline-none`}>
        {title}
      </h1>
      {whose === "own" ? (
        <p className="type-body-lg text-fg-muted">
          Thanks. If your Google or Apple account uses <EmailText>{email}</EmailText> too, you can
          now sign in with it as well.
        </p>
      ) : whose === "already" ? (
        <p className="type-body-lg text-fg-muted">
          This link was used already. Nothing more to do.
        </p>
      ) : whose === "other" ? (
        <>
          <p className="type-body-lg text-fg-muted">
            The link was for a different Webflix account than the one signed in here (
            <EmailText>{email}</EmailText>). If that other account is yours, sign out and sign in to
            it.
          </p>
          <p className="type-body text-fg-muted">
            Didn't create it? {resetLink}: the account becomes yours, and anyone else using it is
            signed out.
          </p>
        </>
      ) : (
        <>
          <p className="type-body-lg text-fg-muted">
            Thanks. To sign in with Google or Apple as well, sign in and add them in Account ›
            Security.
          </p>
          <p className="type-body text-fg-muted">
            Didn't create this account? {resetLink}: the account becomes yours, and anyone else
            using it is signed out.
          </p>
        </>
      )}
      <div className="mt-2 flex w-full flex-col gap-3">
        {whose === "other" ? (
          <>
            {continueButton}
            <Button variant="outline" size="lg" fullWidth asChild>
              <Link to="/logout">Sign out</Link>
            </Button>
          </>
        ) : (
          (continueButton ?? (
            <Button variant="accent" size="lg" fullWidth asChild>
              <Link to="/login" search={{}}>
                Sign in
              </Link>
            </Button>
          ))
        )}
      </div>
    </section>
  );
}
