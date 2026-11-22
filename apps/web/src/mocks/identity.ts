/**
 * Mock of milestone 2's sign-in surface (docs/BACKEND.md §3, "Sign-in, milestone 2"): the offered
 * issuers, linked identities, the account-holder proof and the email links. Federated sign-in
 * itself is a navigation to a real issuer; mock mode stands in for that with a page of its own
 * (`features/member/auth/MockIssuer.tsx`), which calls `completeMockFederation` below.
 *
 * Email links in mock mode: any well-formed token works once; a token starting with `invalid`
 * answers `verification_token_invalid` (to see that screen).
 */
import {
  ELEVATION_TTL_SEC,
  type LinkedIdentity,
  type OidcIntent,
  type OidcOutcome,
  type OidcProvider,
  type REAUTH_METHODS,
} from "@webflix/contracts";
import { iso } from "./catalog.ts";
import type { MockState } from "./state.ts";

/** The identity part of the mock account (absent in older saved states: the defaults apply). */
export interface MockIdentityState {
  hasPassword: boolean;
  emailVerified: boolean;
  identities: LinkedIdentity[];
  /** Epoch ms; the session's account-holder proof. */
  elevatedUntil: number | null;
  /** Whether the linked issuers report a fresh sign-in (false: a Google without `auth_time`). */
  issuersProveFreshness: boolean;
}

export function identityOf(state: MockState): MockIdentityState {
  state.identity ??= {
    hasPassword: true,
    emailVerified: true,
    identities: [],
    elevatedUntil: null,
    issuersProveFreshness: true,
  };
  return state.identity;
}

export function mockElevated(state: MockState, now = Date.now()): boolean {
  const until = identityOf(state).elevatedUntil;
  return until !== null && until > now;
}

/** The account fields identity serves on the session. */
export function identityAccountFields(state: MockState) {
  const identity = identityOf(state);
  return { emailVerified: identity.emailVerified, hasPassword: identity.hasPassword };
}

export function elevationOf(state: MockState) {
  const identity = identityOf(state);
  const methods: Array<(typeof REAUTH_METHODS)[number]> = [];
  if (identity.hasPassword) methods.push("password");
  if (identity.issuersProveFreshness) {
    for (const linked of identity.identities) methods.push(linked.provider);
  }
  return {
    elevatedUntil:
      mockElevated(state) && identity.elevatedUntil !== null
        ? new Date(identity.elevatedUntil).toISOString()
        : null,
    methods,
  };
}

export function elevate(state: MockState): void {
  identityOf(state).elevatedUntil = Date.now() + ELEVATION_TTL_SEC * 1000;
}

/** A mock email link token: well formed, and not one marked to fail. */
export function mockTokenValid(token: string): boolean {
  return !token.startsWith("invalid");
}

/** What the mock issuer page offers for each intent. */
export type MockIssuerChoice =
  | "existing"
  | "new"
  | "link-required"
  | "confirm"
  | "in-use"
  | "cancel"
  | "fail";

/**
 * Apply a choice made on the mock issuer page to the saved mock state, and return the outcome
 * the callback would have redirected with.
 */
export function completeMockFederation(
  state: MockState,
  provider: OidcProvider,
  intent: OidcIntent,
  choice: MockIssuerChoice,
): OidcOutcome {
  if (choice === "cancel") return "cancelled";
  if (choice === "fail") return "failed";
  if (choice === "link-required") return "link-required";
  if (choice === "in-use") return "identity-in-use";
  const identity = identityOf(state);
  const now = Date.now();
  if (intent === "signin" && choice === "new") {
    state.signedIn = true;
    state.account = {
      id: `acct-${provider}-${now.toString(36)}`,
      email: "riley.chen@example.com",
      password: "",
      createdAt: new Date(now).toISOString(),
    };
    state.profiles = [];
    state.activeProfileId = null;
    state.identity = {
      hasPassword: false,
      emailVerified: true,
      identities: [{ provider, emailAtLink: "riley.chen@example.com", linkedAt: iso(0) }],
      elevatedUntil: null,
      issuersProveFreshness: true,
    };
    return "signed-up";
  }
  if (intent === "signin") {
    state.signedIn = true;
    state.activeProfileId = null;
    if (!identity.identities.some((linked) => linked.provider === provider)) {
      identity.identities.push({ provider, emailAtLink: state.account.email, linkedAt: iso(0) });
    }
    return "signed-in";
  }
  if (intent === "link") {
    if (!identity.identities.some((linked) => linked.provider === provider)) {
      identity.identities.push({ provider, emailAtLink: state.account.email, linkedAt: iso(0) });
    }
    return "linked";
  }
  elevate(state);
  return "reauthenticated";
}
