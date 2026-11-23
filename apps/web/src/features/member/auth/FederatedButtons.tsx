import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import {
  OIDC_ERROR_PARAM,
  type OidcOutcome,
  type OidcProvider,
  type SignInProvider,
} from "@webflix/contracts";
import { Button, ProviderMark, Skeleton } from "@webflix/ui";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { queries } from "../../../app/query/queries.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { rememberLinkIntent } from "./linkIntent.ts";
import {
  FUNNEL_RESUME_PATH,
  federatedStartUrl,
  hasProviderMark,
  onPageRestored,
  parseOidcError,
  parseOutcome,
  parseProvider,
  pathWithout,
  providerName,
  signInReturnPath,
} from "./oidc.ts";

export interface FederatedButtonsProps {
  /**
   * The page's purpose: sign in, or sign up. The server signs in an existing account and creates
   * a new one either way, so this only changes the words around the buttons.
   */
  context?: "signin" | "signup";
  /** Where a member who signed in continues (a same-origin path). Default: Who's watching?. */
  redirect?: string;
  /** Where a newly created account continues. Default: the sign-up funnel's next step. */
  signUpNext?: string;
  /**
   * Show what happened when an attempt came back to this page (cancelled, failed, an existing
   * account): on by default, so a page that hosts the buttons needs no code for it.
   */
  showOutcome?: boolean;
  /** An "or" rule above or below the buttons, separating them from the email form. */
  divider?: "before" | "after" | "none";
  className?: string;
}

/**
 * "Continue with Google / Apple": one button per issuer the deployment offers
 * (`GET /auth/providers`), for sign-in and sign-up alike. Each is a real link (it opens in a new
 * tab too) to the server's start route; the attempt always comes back to the sign-in landing,
 * which continues a signed-in member, welcomes a new account, or brings the member back here with
 * the outcome. Renders nothing when the deployment offers no issuer.
 */
export function FederatedButtons({
  context = "signin",
  redirect,
  signUpNext = FUNNEL_RESUME_PATH,
  showOutcome = true,
  divider = "none",
  className,
}: FederatedButtonsProps) {
  const providers = useQuery(queries.signInProviders());
  const from = useLocation({ select: (location) => location.pathname });
  const outcome = useOutcomeFromUrl(showOutcome);

  if (providers.isError || (providers.isSuccess && providers.data.items.length === 0)) {
    // Password sign-in still works: no issuer is not an error worth a message.
    return null;
  }
  const items = providers.data?.items;
  const rule = <OrDivider />;
  return (
    <div className={className}>
      <div className="flex flex-col gap-3">
        {divider === "before" ? rule : null}
        {outcome ? (
          <FederatedOutcomeNotice
            outcome={outcome.outcome}
            error={outcome.error}
            provider={outcome.provider}
            context={context}
            offered={items}
            retryHref={(provider) =>
              federatedStartUrl(
                provider,
                "signin",
                signInReturnPath({ provider, context, from, redirect, next: signUpNext }),
              )
            }
          />
        ) : null}
        {items ? (
          items.map((provider) => (
            <ProviderButton
              key={provider.id}
              provider={provider}
              href={federatedStartUrl(
                provider.id,
                "signin",
                signInReturnPath({
                  provider: provider.id,
                  context,
                  from,
                  redirect,
                  next: signUpNext,
                }),
              )}
            />
          ))
        ) : (
          // Same height as the buttons, so nothing moves when the list arrives.
          <div className="flex flex-col gap-3" aria-busy="true">
            <span className="sr-only">Loading sign-in options</span>
            <Skeleton className="h-12 w-full" radius="md" />
            <Skeleton className="h-12 w-full" radius="md" />
          </div>
        )}
        {divider === "after" ? rule : null}
      </div>
    </div>
  );
}

/** One provider's "Continue with …" link, busy from the click until the page leaves. */
export function ProviderButton({
  provider,
  href,
  label,
}: {
  provider: SignInProvider;
  href: string;
  /** Default "Continue with {name}". */
  label?: string;
}) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => onPageRestored(() => setLeaving(false)), []);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // A second click while the issuer loads would start a second transaction.
    if (leaving) {
      event.preventDefault();
      return;
    }
    // A new tab or window (modifier keys, middle click) leaves this page as it is.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    setLeaving(true);
  };
  const name = provider.displayName;
  return (
    <Button variant="outline" size="lg" fullWidth loading={leaving} asChild>
      <a href={href} onClick={onClick} data-provider={provider.id}>
        {leaving ? null : hasProviderMark(provider.id) ? (
          <ProviderMark provider={provider.id} />
        ) : null}
        <span>{leaving ? `Opening ${name}…` : (label ?? `Continue with ${name}`)}</span>
      </a>
    </Button>
  );
}

/** The thin "or" rule between the provider buttons and the email form. */
export function OrDivider() {
  return (
    <div aria-hidden className="flex items-center gap-4 py-1">
      <span className="h-px flex-1 bg-line" />
      <span className="type-label text-fg-subtle">or</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

// --- What came back ---------------------------------------------------------------------------

export interface ReturnedOutcome {
  outcome: OidcOutcome;
  provider: OidcProvider;
  /** Why a refused attempt failed (`?oidcError=`), when the server said. */
  error?: string | undefined;
}

/**
 * The outcome a federated attempt brought back to this page (`?oidc=…&provider=…`), read once
 * when the page opens. The parameters then leave the address bar (replaced, not a new history
 * entry), so a reload or a copied link does not repeat the message.
 */
export function useOutcomeFromUrl(enabled = true): ReturnedOutcome | null {
  const router = useRouter();
  const [returned] = useState<ReturnedOutcome | null>(() => {
    if (!enabled) return null;
    const params = new URLSearchParams(router.state.location.searchStr);
    const outcome = parseOutcome(params.get("oidc"));
    const provider = parseProvider(params.get("provider"));
    const error = parseOidcError(params.get(OIDC_ERROR_PARAM));
    return outcome && provider && !params.has("confirm") ? { outcome, provider, error } : null;
  });
  const cleared = useRef(false);
  useEffect(() => {
    if (!returned || cleared.current) return;
    cleared.current = true;
    router.history.replace(
      pathWithout(router.history.location.href),
      router.history.location.state,
    );
  }, [returned, router]);
  return returned;
}

export interface OutcomeCopy {
  tone: "danger" | "info" | "accent";
  title: string;
  body: string;
  /** A second paragraph: the other way through. */
  more?: string;
}

/**
 * Words for an attempt that left the member signed out. They say what happened and what to do,
 * and never more than the outcome itself tells: `link-required` already means an account uses
 * the address the provider gave, so saying so reveals nothing new (no address is shown).
 */
export function outcomeCopy(
  outcome: OidcOutcome,
  name: string,
  context: "signin" | "signup",
  error?: string,
): OutcomeCopy | null {
  const verb = context === "signup" ? "sign up" : "sign in";
  if (outcome === "failed" && error === "rate_limited") {
    return {
      tone: "danger",
      title: "Too many attempts",
      body: `For your security, ${context === "signup" ? "sign-up" : "sign-in"} with ${name} is paused for a moment. Try again in a minute, or use your email.`,
    };
  }
  switch (outcome) {
    case "cancelled":
      return {
        tone: "info",
        title: `${name} ${context === "signup" ? "sign-up" : "sign-in"} canceled`,
        body:
          context === "signup"
            ? `Nothing was created. Continue with ${name} again, or sign up with your email.`
            : `Nothing changed. Continue with ${name} again, or sign in with your email and password.`,
      };
    case "link-required":
      // Security review H1: a provider attaches itself only to an account whose ways in its
      // owner set up. Everyone else proves the account first: its password, or a reset of it.
      return {
        tone: "accent",
        title: "An account already uses this address",
        body:
          context === "signup"
            ? `The email address of your ${name} account belongs to a Webflix account, and ${name} can't be added to it automatically. Sign in to that account instead: you'll be offered to add ${name} right after.`
            : `The email address of your ${name} account belongs to a Webflix account, and ${name} can't be added to it automatically. Sign in below with that account's password: you'll be offered to add ${name} right after.`,
        more: "Don't know the password, or didn't create this account? Reset the password. The account becomes yours, and anyone else using it is signed out.",
      };
    case "failed":
    case "identity-in-use":
      return {
        tone: "danger",
        title: `We couldn't ${verb} with ${name}`,
        body:
          context === "signup"
            ? `Nothing was created. Try again, or sign up with your email.`
            : `Nothing was changed. Try again, or sign in with your email and password.`,
      };
    default:
      // Signed in, signed up, linked, reauthenticated: never shown as a notice here.
      return null;
  }
}

/** The designed message for an attempt that came back to a sign-in or sign-up page. */
export function FederatedOutcomeNotice({
  outcome,
  provider,
  context,
  offered,
  retryHref,
  extra,
  error,
}: {
  outcome: OidcOutcome;
  provider: OidcProvider;
  context: "signin" | "signup";
  /** Why it failed, when the server said (`?oidcError=`). */
  error?: string | undefined;
  offered?: readonly SignInProvider[] | undefined;
  retryHref: (provider: OidcProvider) => string;
  /** More actions after the built-in ones. */
  extra?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Screen reader and keyboard users start from the message, not the top of the page.
  useEffect(() => {
    ref.current?.focus();
  }, []);
  // The member wanted this provider on their account: offer it once they have proved the
  // account (signed in, or reset its password), wherever that happens.
  useEffect(() => {
    if (outcome === "link-required") rememberLinkIntent(provider);
  }, [outcome, provider]);
  const name = providerName(provider, offered);
  const copy = outcomeCopy(outcome, name, context, error);
  if (!copy) return null;
  const actions: ReactNode[] = [];
  if ((outcome === "failed" && error !== "rate_limited") || outcome === "identity-in-use") {
    actions.push(
      <a
        key="retry"
        href={retryHref(provider)}
        className="focus-ring rounded-xs type-label text-fg underline underline-offset-2"
      >
        Try again with {name}
      </a>,
    );
  }
  if (outcome === "link-required" && context === "signup") {
    actions.push(
      <Link
        key="signin"
        to="/login"
        search={{ oidc: "link-required", provider }}
        className="focus-ring rounded-xs type-label text-fg underline underline-offset-2"
      >
        Sign in instead
      </Link>,
    );
  }
  if (outcome === "link-required") {
    actions.push(
      <Link
        key="reset"
        to="/forgot-password"
        className="focus-ring rounded-xs type-label text-fg underline underline-offset-2"
      >
        Reset the password
      </Link>,
    );
  }
  return (
    <FormAlert
      ref={ref}
      tone={copy.tone}
      title={copy.title}
      action={actions.length > 0 || extra ? [...actions, extra] : undefined}
    >
      {copy.more ? (
        <>
          <p>{copy.body}</p>
          <p className="mt-2">{copy.more}</p>
        </>
      ) : (
        copy.body
      )}
    </FormAlert>
  );
}
