/**
 * Federated sign-in, the browser's side (docs/BLUEPRINT-M2.md §4.1, docs/BACKEND.md §3): every
 * attempt is a full-page navigation to `GET /api/v1/auth/oidc/{provider}/start`, and the issuer
 * sends the browser back to the `returnTo` path with `?oidc=<outcome>` appended. Nothing about
 * the attempt is kept in the page: the server holds the transaction in a sealed cookie, so a tab
 * closed half-way leaves nothing behind, and the callback may land in any tab of the browser.
 */
import {
  navigationUrl,
  OIDC_ERROR_PARAM,
  OIDC_OUTCOMES,
  OIDC_PROVIDERS,
  OIDC_RESULT_PARAM,
  type OidcIntent,
  type OidcOutcome,
  type OidcProvider,
} from "@webflix/contracts";
import { useLatest } from "@webflix/ui";
import { useEffect } from "react";
import { isSafeRedirect } from "../../../app/router/search.ts";

/** Where every sign-in or sign-up attempt comes back to (it dispatches on the outcome). */
export const SIGN_IN_LANDING_PATH = "/login/continue";

/**
 * The sign-up funnel's single entry. A signed-in account whose sign-up is not finished goes here
 * (a new account from Google or Apple, or an existing one that never chose a plan, paid or made
 * a profile): the funnel's guards send it on to the step its state calls for. The membership
 * rules live there, not here.
 */
export const FUNNEL_RESUME_PATH = "/signup";

/**
 * Where a member continues once signed in. An account with profiles has finished signing up:
 * where they were going, else Who's watching?. Anything else is an unfinished sign-up, which the
 * funnel resumes (it has no profile to choose and nothing to watch yet).
 */
export function afterSignInPath(
  session: { authenticated: true; profiles: readonly unknown[] },
  redirect: string | undefined,
): string {
  if (session.profiles.length === 0) return FUNNEL_RESUME_PATH;
  return redirect && isSafeRedirect(redirect) ? redirect : "/profiles";
}

/** Names for a provider the deployment no longer lists (an identity linked before). */
const FALLBACK_NAMES: Record<OidcProvider, string> = {
  google: "Google",
  apple: "Apple",
  keycloak: "Keycloak",
};

export function providerName(
  provider: OidcProvider,
  offered?: readonly { id: string; displayName: string }[],
): string {
  return offered?.find((item) => item.id === provider)?.displayName ?? FALLBACK_NAMES[provider];
}

/** The member issuers with a mark of their own. */
export function hasProviderMark(provider: string): provider is "google" | "apple" {
  return provider === "google" || provider === "apple";
}

export function parseOutcome(value: unknown): OidcOutcome | undefined {
  return typeof value === "string" && (OIDC_OUTCOMES as readonly string[]).includes(value)
    ? (value as OidcOutcome)
    : undefined;
}

export function parseProvider(value: unknown): OidcProvider | undefined {
  return typeof value === "string" && (OIDC_PROVIDERS as readonly string[]).includes(value)
    ? (value as OidcProvider)
    : undefined;
}

/** The URL that starts a federated sign-in: assign it to the location (never fetch it). */
export function federatedStartUrl(
  provider: OidcProvider,
  intent: OidcIntent,
  returnTo: string,
): string {
  if (__WEBFLIX_MOCK__) {
    // Mock mode has no issuer: a stand-in page on the landing route answers for it.
    const params = new URLSearchParams({ provider, intent, returnTo });
    return `${SIGN_IN_LANDING_PATH}?mock-issuer=1&${params}`;
  }
  return navigationUrl("startOidc", {
    params: { provider },
    query: { intent, returnTo: isSafeRedirect(returnTo) ? returnTo : "/" },
  });
}

/** Where a sign-in or sign-up started from the buttons comes back to. */
export function signInReturnPath(options: {
  provider: OidcProvider;
  context: "signin" | "signup";
  /** The page the buttons are on: signed-out outcomes are shown there. */
  from: string;
  /** Where a member who signed in continues. */
  redirect?: string | undefined;
  /** Where a newly created account continues. */
  next?: string | undefined;
}): string {
  const params = new URLSearchParams({ provider: options.provider, context: options.context });
  if (isSafeRedirect(options.from)) params.set("from", options.from);
  if (options.redirect && isSafeRedirect(options.redirect))
    params.set("redirect", options.redirect);
  if (options.next && isSafeRedirect(options.next)) params.set("next", options.next);
  return `${SIGN_IN_LANDING_PATH}?${params}`;
}

/** The parameters the outcome of a federated attempt adds to (or carries on) a page's URL. */
export const OUTCOME_PARAMS = [OIDC_RESULT_PARAM, OIDC_ERROR_PARAM, "provider", "confirm"] as const;

/**
 * Why a navigation the server refused came back `failed` (`?oidcError=`, the error code its
 * problem document would have carried): `rate_limited`, `reauthentication_required`… Only a
 * well-formed code is kept; the screens give a few their own words and the rest the general one.
 */
export function parseOidcError(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : undefined;
}

/** `path` (with its query) plus the given parameters, replacing any of the same name. */
export function withParams(path: string, params: Record<string, string | undefined>): string {
  const url = new URL(path, "http://webflix.invalid");
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * `href` (a same-origin path with its query, as the router's location has it) without the given
 * parameters and without a fragment: the page to come back to, or the address once read.
 */
export function pathWithout(href: string, names: readonly string[] = OUTCOME_PARAMS): string {
  const url = new URL(href, "http://webflix.invalid");
  for (const name of names) url.searchParams.delete(name);
  return `${url.pathname}${url.search}`;
}

// --- Other tabs -----------------------------------------------------------------------------------

/**
 * What changed about this browser's sign-in, announced to the app's other tabs. A federated
 * sign-in can finish in another tab than the one that started it (a link opened in a new tab, a
 * provider app that hands back to the browser): the starting tab then moves on by itself.
 */
export type AuthChange = "signed-in" | "elevated" | "signed-out";

const CHANNEL = "webflix:auth";

export function announceAuthChange(change: AuthChange): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ change });
    channel.close();
  } catch {
    // Announcing is a courtesy: the other tabs also re-check when they are shown again.
  }
}

/**
 * Call `onChange` when another tab announces a change, and when this tab is shown again (the
 * member comes back to it: the other tab may predate the announcement, or be another window).
 */
export function useAuthChangeElsewhere(onChange: (change: AuthChange | "shown") => void): void {
  const latest = useLatest(onChange);
  useEffect(() => {
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    const onMessage = (event: MessageEvent) => {
      const change = (event.data as { change?: AuthChange } | null)?.change;
      if (change) latest.current(change);
    };
    const onShown = () => {
      if (document.visibilityState === "visible") latest.current("shown");
    };
    channel?.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onShown);
    window.addEventListener("focus", onShown);
    return () => {
      channel?.removeEventListener("message", onMessage);
      channel?.close();
      document.removeEventListener("visibilitychange", onShown);
      window.removeEventListener("focus", onShown);
    };
  }, [latest]);
}

/**
 * True while this page is navigating away to an issuer, reset when the browser shows the page
 * again from its back-forward cache (the member pressed Back on the issuer's page): otherwise a
 * button would stay on "Opening Google…" forever.
 */
export function onPageRestored(reset: () => void): () => void {
  const handler = (event: PageTransitionEvent) => {
    if (event.persisted) reset();
  };
  window.addEventListener("pageshow", handler);
  return () => window.removeEventListener("pageshow", handler);
}
