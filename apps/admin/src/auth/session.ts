/**
 * The staff session, in this tab's memory only.
 *
 * Tokens (access, refresh, ID) live in this module's closure: never in `localStorage`,
 * `sessionStorage`, IndexedDB or a cookie, never in a global, never in a URL after the callback
 * has read its code. The member app shares this origin, so anything stored would be readable by
 * its scripts; memory is not. What that costs and how it is paid:
 *
 * - **A reload** loses the tokens. The console then asks the issuer again with `prompt=none`: a
 *   top-level redirect that comes straight back signed in while the issuer's own session lasts
 *   (Keycloak's SSO session, or the development issuer's), and lands on "Sign in" when it does
 *   not. The issuer stays the one place that decides whether someone is signed in (its idle and
 *   maximum session lifetimes, MFA); a reload costs a redirect, not a password.
 * - **An access token near its end** (five minutes by default) is renewed with the refresh token
 *   a minute or so before it expires, and on demand before a request when the tab slept. A
 *   request the API refuses as unauthenticated is renewed once and sent again (the guard refuses
 *   before anything runs, so sending it again is safe). When renewal is refused (the issuer's
 *   session ended or idled out) the session ends: what was on screen is dropped from memory and
 *   "Your session ended" offers to sign in again and come back to the same page.
 * - **Left unattended** a tab does not keep itself alive: nothing is renewed after 15 minutes
 *   without a key press or pointer action in it (background refreshes of a screen do not count),
 *   so an open console on an empty desk signs itself out within five minutes after that, and what
 *   it showed is cleared. The issuer's own idle and maximum lifetimes still apply on top.
 * - **Sign out** forgets the tokens, tells the console's other tabs (a message with no data on a
 *   `BroadcastChannel`), and ends the issuer's session through its end-session endpoint.
 */
import type { RuntimeConfig } from "../config/runtime.ts";
import {
  authorizationUrl,
  discover,
  endSessionUrl,
  exchangeCode,
  type IssuerMetadata,
  OidcError,
  refreshTokens,
  type TokenSet,
} from "./oidc.ts";
import { codeChallenge, randomToken } from "./pkce.ts";
import {
  markSignedOut,
  purgeTransactions,
  saveTransaction,
  takeSignedOutMark,
  takeTransaction,
  transactionStorageAvailable,
} from "./transaction.ts";

export type SignedOutReason =
  /** Never signed in in this tab, and the issuer has no session (or a silent sign-in failed). */
  | "required"
  /** The staff member signed out (here or in another tab). */
  | "signed-out"
  /** Renewal was refused: the issuer's session ended. */
  | "expired"
  /** Nobody used this tab for the idle limit: the console stopped renewing. */
  | "idle"
  /** The staff member cancelled at the issuer. */
  | "cancelled"
  /** The sign-in did not complete (an invalid or replayed response, an issuer error). */
  | "failed";

export type AuthState =
  | { status: "starting" }
  | { status: "redirecting" }
  | { status: "signed-in" }
  | { status: "signed-out"; reason: SignedOutReason; returnTo: string; detail?: string }
  | { status: "unavailable"; kind: "issuer" | "storage"; detail: string };

export interface SessionDeps {
  config: RuntimeConfig;
  now?: () => number;
  /** Leave the page for the issuer (tests record it). */
  navigate?: (url: string) => void;
  /** Replace the current URL without reloading (drops the code from the address bar). */
  replaceUrl?: (path: string) => void;
  discover?: (config: RuntimeConfig) => Promise<IssuerMetadata>;
  channel?: Pick<BroadcastChannel, "postMessage" | "addEventListener" | "close"> | null;
  /** No renewal after this long without a key press or pointer action (default 15 minutes). */
  idleMs?: number;
}

/** Renew this long before the access token ends (or a fifth of its lifetime when shorter). */
const RENEW_AHEAD_MS = 60_000;
/** A token this close to its end is renewed before use. */
const MIN_REMAINING_MS = 15_000;
/** The console's own idle limit: the most privileged screen does not outlive an empty desk. */
export const IDLE_MS = 15 * 60_000;
const SILENT_ERRORS = new Set([
  "login_required",
  "interaction_required",
  "consent_required",
  "account_selection_required",
]);

export interface StaffSession {
  getState(): AuthState;
  subscribe(listener: () => void): () => void;
  /** Decide what this page load is: a callback, a reload (silent sign-in) or signed out. */
  start(location: { pathname: string; search: string }): Promise<void>;
  /** Go to the issuer; `returnTo` is a path under the base. */
  signIn(returnTo: string, options?: { silent?: boolean }): Promise<void>;
  signOut(): void;
  /** For the API client: a current access token (renewed first when near its end). */
  accessToken(): Promise<string>;
  /** After a 401: renew once; false when the session cannot continue. */
  renewAfterRefusal(): Promise<boolean>;
  /** End the session now (renewal refused); `returnTo` defaults to the current path. */
  expire(detail?: string): void;
}

export function createStaffSession(deps: SessionDeps): StaffSession {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const navigate = deps.navigate ?? ((url: string) => window.location.assign(url));
  const replaceUrl =
    deps.replaceUrl ?? ((path: string) => window.history.replaceState(null, "", path));
  const discoverIssuer = deps.discover ?? discover;
  const channel =
    deps.channel === undefined
      ? typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel("webflix-admin")
      : deps.channel;

  let state: AuthState = { status: "starting" };
  let tokens: TokenSet | null = null;
  let metadata: Promise<IssuerMetadata> | null = null;
  let renewing: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idleMs = deps.idleMs ?? IDLE_MS;
  let lastActivity = now();
  const listeners = new Set<() => void>();

  function set(next: AuthState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function issuer(): Promise<IssuerMetadata> {
    metadata ??= discoverIssuer(config).catch((error: unknown) => {
      metadata = null; // Try again next time: the issuer may have been down for a moment.
      throw error;
    });
    return metadata;
  }

  /** A path under the base, or the base itself (never another origin, never `//host`). */
  function safeReturn(path: string | null | undefined): string {
    if (!path?.startsWith(config.base) || path.startsWith("//")) return config.base;
    if (path.startsWith(`${config.base}auth/`)) return config.base;
    return path;
  }

  function currentPath(): string {
    if (typeof window === "undefined") return config.base;
    return safeReturn(`${window.location.pathname}${window.location.search}`);
  }

  function clearTokens(): void {
    tokens = null;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    if (!tokens?.refreshToken) return;
    const remaining = tokens.expiresAt - now();
    const ahead = Math.min(RENEW_AHEAD_MS, remaining / 5);
    timer = setTimeout(() => void renew(), Math.max(1_000, remaining - ahead));
  }

  function accept(next: TokenSet): void {
    tokens = next;
    schedule();
  }

  async function renew(): Promise<boolean> {
    if (!tokens) return false;
    if (now() - lastActivity > idleMs) {
      endSession("idle");
      return false;
    }
    renewing ??= (async () => {
      const current = tokens;
      if (!current) return false;
      try {
        accept(await refreshTokens(await issuer(), config, current, now));
        return true;
      } catch (error) {
        const unreachable = error instanceof OidcError && error.code === "issuer_unreachable";
        if (unreachable && current.expiresAt - now() > MIN_REMAINING_MS) {
          // The token still works: try again shortly rather than ending a working session.
          timer = setTimeout(() => void renew(), 10_000);
          return true;
        }
        expire(
          unreachable
            ? "The staff sign-in service did not answer, so the session could not be renewed."
            : undefined,
        );
        return false;
      } finally {
        renewing = null;
      }
    })();
    return renewing;
  }

  function endSession(reason: "expired" | "idle", detail?: string): void {
    if (state.status !== "signed-in" && tokens === null) return;
    clearTokens();
    set({
      status: "signed-out",
      reason,
      returnTo: currentPath(),
      ...(detail ? { detail } : {}),
    });
  }

  function expire(detail?: string): void {
    endSession("expired", detail);
  }

  channel?.addEventListener("message", (event: Event) => {
    const data = (event as MessageEvent<unknown>).data as { type?: unknown } | null;
    if (data?.type !== "signed-out" || state.status !== "signed-in") return;
    clearTokens();
    set({ status: "signed-out", reason: "signed-out", returnTo: currentPath() });
  });

  if (typeof document !== "undefined") {
    // Presence is a person's own action in this tab, never a timer or a background refresh.
    for (const type of ["keydown", "pointerdown", "wheel", "touchstart"] as const) {
      document.addEventListener(
        type,
        () => {
          lastActivity = now();
        },
        { capture: true, passive: true },
      );
    }
    // A tab that slept past its renewal time renews as soon as it is looked at again.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || !tokens) return;
      if (tokens.expiresAt - now() < RENEW_AHEAD_MS) void renew();
    });
  }

  async function signIn(returnTo: string, options: { silent?: boolean } = {}): Promise<void> {
    if (!transactionStorageAvailable()) {
      set({
        status: "unavailable",
        kind: "storage",
        detail:
          "This browser is blocking the session storage that signing in needs. Allow site data for this address, or use another browser.",
      });
      return;
    }
    let found: IssuerMetadata;
    try {
      found = await issuer();
    } catch (error) {
      set({
        status: "unavailable",
        kind: "issuer",
        detail: error instanceof Error ? error.message : "The staff sign-in service did not answer",
      });
      return;
    }
    const transaction = {
      state: randomToken(32),
      nonce: randomToken(32),
      verifier: randomToken(32),
      returnTo: safeReturn(returnTo),
      silent: options.silent === true,
      createdAt: now(),
    };
    saveTransaction(transaction);
    set({ status: "redirecting" });
    navigate(
      authorizationUrl(found, config, {
        state: transaction.state,
        nonce: transaction.nonce,
        challenge: await codeChallenge(transaction.verifier),
        ...(options.silent ? { prompt: "none" as const } : {}),
      }),
    );
  }

  async function callback(search: string): Promise<void> {
    const params = new URLSearchParams(search);
    const transaction = takeTransaction(params.get("state") ?? "", now());
    // The code leaves the address bar (and this history entry) before anything else happens.
    replaceUrl(transaction ? transaction.returnTo : config.base);
    if (!transaction) {
      set({
        status: "signed-out",
        reason: "failed",
        returnTo: config.base,
        detail: "This sign-in was already used, has expired, or was started in another tab.",
      });
      return;
    }
    const { returnTo } = transaction;
    const error = params.get("error");
    if (error) {
      if (transaction.silent && SILENT_ERRORS.has(error)) {
        set({ status: "signed-out", reason: "required", returnTo });
      } else if (error === "access_denied") {
        set({ status: "signed-out", reason: "cancelled", returnTo });
      } else {
        set({
          status: "signed-out",
          reason: "failed",
          returnTo,
          detail: `The staff sign-in service answered “${error.slice(0, 60)}”.`,
        });
      }
      return;
    }
    const code = params.get("code");
    try {
      const found = await issuer();
      const iss = params.get("iss");
      // RFC 9207 mix-up defence: a response from another issuer is refused before redemption.
      if ((iss !== null && iss !== found.issuer) || (found.issInResponse && iss === null)) {
        throw new OidcError("issuer_mismatch", "The response came from another issuer.");
      }
      if (!code) throw new OidcError("invalid_response", "The response carried no code.");
      accept(await exchangeCode(found, config, code, transaction.verifier, now));
      set({ status: "signed-in" });
    } catch (caught) {
      clearTokens();
      set({
        status: "signed-out",
        reason: "failed",
        returnTo,
        detail:
          caught instanceof OidcError && caught.code === "issuer_unreachable"
            ? "The staff sign-in service did not answer. Try again in a moment."
            : "The sign-in could not be completed. Try again.",
      });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(location) {
      purgeTransactions(now());
      if (location.pathname === `${config.base}auth/callback`) {
        await callback(location.search);
        return;
      }
      const returnTo = safeReturn(`${location.pathname}${location.search}`);
      if (takeSignedOutMark(now())) {
        set({ status: "signed-out", reason: "signed-out", returnTo: config.base });
        return;
      }
      await signIn(returnTo, { silent: true });
    },
    signIn,
    signOut() {
      const idToken = tokens?.idToken ?? null;
      clearTokens();
      channel?.postMessage({ type: "signed-out" });
      markSignedOut(now());
      set({ status: "redirecting" });
      issuer()
        .then((found) => {
          const url = endSessionUrl(found, config, idToken);
          if (url) navigate(url);
          else set({ status: "signed-out", reason: "signed-out", returnTo: config.base });
        })
        .catch(() => set({ status: "signed-out", reason: "signed-out", returnTo: config.base }));
    },
    async accessToken() {
      if (tokens && tokens.expiresAt - now() < MIN_REMAINING_MS) await renew();
      return tokens?.accessToken ?? "";
    },
    renewAfterRefusal: renew,
    expire,
  };
}
