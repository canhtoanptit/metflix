import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { OIDC_ERROR_PARAM, type OidcProvider } from "@webflix/contracts";
import { Button, CheckCircleIcon, EmailText, ProviderMark, Spinner, toast } from "@webflix/ui";
import { lazy, type ReactNode, Suspense, useEffect, useRef } from "react";
import { queries } from "../../../app/query/queries.ts";
import { useSession } from "../../../app/session/session.ts";
import { AuthBackdrop } from "../shared/AuthBackdrop.tsx";
import { MemberHeader } from "../shared/Chrome.tsx";
import { forgetDeletionOnSignIn } from "../shared/deletionMemory.ts";
import { forgetLinkIntent, linkOfferPath, pendingLinkIntent } from "./linkIntent.ts";
import {
  afterSignInPath,
  announceAuthChange,
  FUNNEL_RESUME_PATH,
  federatedStartUrl,
  hasProviderMark,
  parseOidcError,
  providerName,
  signInReturnPath,
  withParams,
} from "./oidc.ts";

const route = getRouteApi("/public/login/continue");

// Mock mode's stand-in for the provider's page; the constant drops it from real builds.
const MockIssuer = __WEBFLIX_MOCK__
  ? lazy(() => import("./MockIssuer.tsx").then((module) => ({ default: module.MockIssuer })))
  : null;

/**
 * Where every "Continue with Google / Apple" attempt comes back (`returnTo`, with `?oidc=` added
 * by the server). It dispatches on the outcome:
 * - signed in: on to where the member was going (or the sign-up funnel, if it is not finished);
 * - signed up: a welcome that says an account was just created, and what comes next;
 * - signed out (cancelled, failed, an existing account that may not be linked automatically):
 *   back to the page the buttons were on, which shows what happened and what to do.
 * The page is public: the callback may land in any tab, signed in or not, and the member may come
 * back to this URL later (a reload shows the same answer for the session as it now is).
 */
export function SignInLandingPage() {
  const search = route.useSearch();
  if (MockIssuer && search["mock-issuer"] && search.provider && search.intent) {
    return (
      <Suspense fallback={null}>
        <MockIssuer
          provider={search.provider}
          intent={search.intent}
          returnTo={search.returnTo ?? "/"}
        />
      </Suspense>
    );
  }
  return <Landing />;
}

function Landing() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const session = useSession();
  const providers = useQuery(queries.signInProviders());
  const provider: OidcProvider = search.provider ?? "google";
  const name = providerName(provider, providers.data?.items);
  const context = search.context ?? "signin";
  const outcome = search.oidc;
  const signedIn = session.authenticated;

  const dispatched = useRef(false);
  useEffect(() => {
    if (dispatched.current) return;
    dispatched.current = true;
    if (!outcome) {
      void navigate({ to: "/login", search: {}, replace: true });
      return;
    }
    if ((outcome === "signed-in" || outcome === "signed-up") && signedIn) {
      // Another tab of this browser may still show the sign-in page: it moves on by itself.
      announceAuthChange("signed-in");
      forgetDeletionOnSignIn();
      if (outcome === "signed-in") {
        toast.success(`Signed in with ${name}`, { id: "sign-in" });
        // Signed in another way after `link-required` for another provider: offer that one.
        const linking = pendingLinkIntent();
        if (linking === provider) forgetLinkIntent();
        const next =
          linking && linking !== provider
            ? linkOfferPath(linking)
            : afterSignInPath(session, search.redirect);
        void navigate({ href: next, replace: true });
      }
      return;
    }
    if (outcome === "linked" || outcome === "reauthenticated") {
      // Only Account starts these; they never return here unless the URL was edited.
      void navigate({ to: "/account/security", replace: true });
      return;
    }
    if (outcome !== "signed-in" && outcome !== "signed-up") {
      // Signed out: the page the attempt started from says what happened.
      const from = search.from ?? "/login";
      const params: Record<string, string | undefined> = {
        oidc: outcome,
        provider,
        [OIDC_ERROR_PARAM]: parseOidcError(search.oidcError),
      };
      if (from === "/login" && search.redirect) params.redirect = search.redirect;
      void navigate({ href: withParams(from, params), replace: true });
    }
  }, [outcome, signedIn, session, name, navigate, search, provider]);

  if (outcome === "signed-up" && signedIn) {
    return (
      <Frame>
        <Welcome
          provider={provider}
          name={name}
          email={session.account.email}
          context={context}
          next={search.next ?? FUNNEL_RESUME_PATH}
        />
      </Frame>
    );
  }
  if ((outcome === "signed-in" || outcome === "signed-up") && !signedIn) {
    const retry = federatedStartUrl(
      provider,
      "signin",
      signInReturnPath({
        provider,
        context,
        from: search.from ?? "/login",
        redirect: search.redirect,
        next: search.next,
      }),
    );
    return (
      <Frame>
        <NotKept name={name} retryHref={retry} />
      </Frame>
    );
  }
  return (
    <Frame>
      <Spinner size="lg" label={outcome === "signed-in" ? "Signing you in" : "One moment"} />
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas">
      <AuthBackdrop />
      <MemberHeader />
      <main
        id="main"
        className="relative z-(--z-raised) flex flex-1 items-center justify-center px-gutter pt-4 pb-nav"
      >
        {children}
      </main>
    </div>
  );
}

const CARD =
  "flex w-full max-w-form flex-col items-center gap-5 text-center md:rounded-2xl md:border md:border-line-subtle md:bg-canvas/85 md:p-12 md:shadow-xl md:backdrop-blur-md";

/** A new account was just created through a provider: say so plainly, then the next step. */
function Welcome({
  provider,
  name,
  email,
  context,
  next,
}: {
  provider: OidcProvider;
  name: string;
  email: string;
  context: "signin" | "signup";
  next: string;
}) {
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <section className={CARD} aria-labelledby="welcome-heading" data-testid="signed-up">
      <span className="relative grid size-16 place-items-center rounded-full bg-positive-subtle text-positive">
        <CheckCircleIcon size="xl" />
        {hasProviderMark(provider) ? (
          <span className="absolute -end-1 -bottom-1 grid size-7 place-items-center rounded-full bg-surface-1 text-fg ring-2 ring-canvas">
            <ProviderMark provider={provider} className="size-4" />
          </span>
        ) : null}
      </span>
      <h1
        id="welcome-heading"
        ref={headingRef}
        tabIndex={-1}
        className="type-card-headline text-fg outline-none"
      >
        Welcome to Webflix
      </h1>
      <p className="type-body-lg text-fg-muted">
        {context === "signin"
          ? `There was no Webflix account for your ${name} account, so we created one.`
          : "Your account is ready."}{" "}
        You'll sign in with {name} as <EmailText>{email}</EmailText>.
      </p>
      <Button variant="accent" size="lg" fullWidth asChild className="mt-2">
        <a
          href={next}
          onClick={(event) => {
            event.preventDefault();
            void navigate({ href: next });
          }}
        >
          Choose your plan
        </a>
      </Button>
      <p className="type-body-sm text-fg-subtle">
        You can also set a password later in Account › Security, to sign in with your email.
      </p>
      <p className="type-body-sm text-fg-muted">
        Not the account you meant?{" "}
        <Link
          to="/logout"
          className="focus-ring rounded-xs font-semibold text-fg underline underline-offset-2"
        >
          Sign out
        </Link>
      </p>
    </section>
  );
}

/**
 * The provider said yes but this browser holds no session: its cookie was refused (blocked
 * cookies, a private window that dropped it) or this tab is an old one opened after signing out.
 */
function NotKept({ name, retryHref }: { name: string; retryHref: string }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <section className={CARD} aria-labelledby="not-kept-heading">
      <h1
        id="not-kept-heading"
        ref={headingRef}
        tabIndex={-1}
        className="type-card-headline text-fg outline-none"
      >
        You're not signed in
      </h1>
      <p className="type-body-lg text-fg-muted">
        {name} answered, but this browser didn't keep you signed in. Check that cookies are allowed
        for Webflix, then try again.
      </p>
      <div className="mt-2 flex w-full flex-col gap-3">
        <Button variant="accent" size="lg" fullWidth asChild>
          <a href={retryHref}>Try again with {name}</a>
        </Button>
        <Button variant="outline" size="lg" fullWidth asChild>
          <Link to="/login" search={{}}>
            Sign in with email
          </Link>
        </Button>
      </div>
    </section>
  );
}
