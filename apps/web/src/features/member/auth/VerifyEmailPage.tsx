import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError } from "@webflix/contracts";
import { Button, CheckCircleIcon, ErrorState, Spinner } from "@webflix/ui";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { qk } from "../../../app/query/keys.ts";
import { useSession } from "../../../app/session/session.ts";
import { DeadLink } from "./DeadLink.tsx";
import { forgetLinkToken, looksLikeLinkToken, useLinkToken } from "./emailLink.ts";
import { afterSignInPath } from "./oidc.ts";
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

type State =
  | { status: "verifying" }
  | { status: "verified" }
  | { status: "invalid" }
  | { status: "error"; error: unknown };

/**
 * The emailed verification link. It verifies as soon as it opens (there is nothing to decide),
 * in any browser, signed in or not. A link that was already used by the signed-in account, whose
 * address is verified, says so instead of calling the link dead.
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

  useEffect(() => {
    if (!valid) return;
    let current = true;
    setState({ status: "verifying" });
    confirmOnce(token)
      .then(() => {
        if (!current) return;
        forgetLinkToken(TOKEN_KEY);
        setState({ status: "verified" });
        void queryClient.invalidateQueries({ queryKey: qk.session() });
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
  }, [token, valid, queryClient, attempt]);

  const alreadyVerified =
    state.status === "invalid" && session.authenticated && session.account.emailVerified === true;

  return (
    <Frame>
      {state.status === "verifying" ? (
        <div className="grid min-h-60 place-items-center" aria-live="polite">
          <Spinner size="lg" label="Verifying your email" />
        </div>
      ) : state.status === "verified" || alreadyVerified ? (
        <Verified already={alreadyVerified} />
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

function Verified({ already }: { already: boolean }) {
  const session = useSession();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const next = session.authenticated
    ? session.activeProfile
      ? "/browse"
      : afterSignInPath(session, undefined)
    : null;
  return (
    <section aria-labelledby="verified" className="flex flex-col items-center gap-5 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-positive-subtle text-positive">
        <CheckCircleIcon size="xl" />
      </span>
      <h1
        id="verified"
        ref={headingRef}
        tabIndex={-1}
        className="type-headline text-fg outline-none"
      >
        {already ? "Your email is already verified" : "Your email is verified"}
      </h1>
      <p className="type-body-lg text-fg-muted">
        Thanks. Webflix can now reach you about your account, and Google or Apple can sign you in to
        it when they use the same address.
      </p>
      <div className="mt-2 flex w-full flex-col gap-3">
        {next ? (
          <Button variant="accent" size="lg" fullWidth asChild>
            <a href={next}>Continue to Webflix</a>
          </Button>
        ) : (
          <Button variant="accent" size="lg" fullWidth asChild>
            <Link to="/login" search={{}}>
              Sign in
            </Link>
          </Button>
        )}
      </div>
    </section>
  );
}
