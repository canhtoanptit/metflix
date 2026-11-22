import type { OidcProvider } from "@webflix/contracts";
import { base64UrlEncode, randomBytes, utf8Encode } from "../encoding.ts";

/**
 * Port: an OpenID Connect relying party for one issuer (milestone 2 §3, §4.1): the authorisation
 * URL, the code exchange and the ID token's validation, with JWKS caching inside the adapter.
 * One generic adapter serves the development issuer, Google, Apple and Keycloak by
 * configuration (packages/dev-idp/README.md lists the provider facts it must handle).
 *
 * Contract (`describeIdentityProviderContract`):
 * - `authorizationUrl` sends `response_type=code`, the exact `redirect_uri`, `state`, `nonce`,
 *   PKCE S256 and `scope` with `openid`; `maxAgeSec` becomes `max_age` (0 forces a fresh
 *   sign-in: the account-holder proof of §4.2).
 * - `redeem` exchanges the code once (a second redemption fails), proving PKCE and the redirect
 *   URI, and returns only a validated identity: signature against the issuer's JWKS, `iss`,
 *   `aud`, `exp`, `nonce` equal to the transaction's. When `maxAgeSec` was sent, `auth_time`
 *   must be present and fresh: a provider that omits it fails closed (`auth_time_missing`).
 * - `email_verified` is normalised to a boolean (Apple sends a string; absent means false).
 * - Every rejection is an `IdentityProviderError` with a `reason`; nothing else is thrown for a
 *   bad response. Identities are keyed by (issuer, subject) only, never by email.
 */
export interface IdentityProvider {
  readonly id: OidcProvider;
  /** The exact issuer identifier the ID token's `iss` must equal. */
  readonly issuer: string;
  /** Shown on the sign-in buttons. */
  readonly displayName: string;
  /**
   * How the issuer answers the callback. `form_post` (Apple) is a cross-site POST: the
   * transaction cookie must then be `SameSite=None; Secure`.
   */
  readonly responseMode: "query" | "form_post";
  /**
   * Whether this issuer's ID tokens reliably carry `auth_time`, so that a fresh sign-in can serve
   * as the account-holder proof (Google's discovery document does not promise it).
   */
  readonly reportsAuthTime: boolean;
  authorizationUrl(request: OidcAuthorizationRequest): Promise<string>;
  redeem(redemption: OidcRedemption): Promise<VerifiedIdentity>;
}

/** The configured issuers, by provider id (absent: not offered by this deployment). */
export type IdentityProviders = Partial<Record<OidcProvider, IdentityProvider>>;

export interface OidcAuthorizationRequest {
  /** Exactly `{publicOrigin}/api/v1/auth/oidc/{provider}/callback`. */
  redirectUri: string;
  state: string;
  nonce: string;
  /** base64url(SHA-256(verifier)), 43 characters (`pkceChallenge`). */
  codeChallenge: string;
  /** Seconds; 0 forces a fresh sign-in. */
  maxAgeSec?: number;
  prompt?: "login" | "select_account" | "none";
  loginHint?: string;
}

export interface OidcRedemption {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  nonce: string;
  /** The `max_age` the authorisation request sent, if any. */
  maxAgeSec?: number;
  /** RFC 9207 `iss` from the authorisation response, when the issuer sends one. */
  responseIssuer?: string | null;
}

export interface VerifiedIdentity {
  provider: OidcProvider;
  issuer: string;
  /** Opaque, up to 255 characters; pairwise per client for Apple. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  /** Epoch ms of the sign-in at the issuer; null when the token did not say. */
  authTime: number | null;
}

export const IDENTITY_FAILURE_REASONS = [
  "invalid_request",
  "invalid_grant",
  "invalid_token",
  "issuer_mismatch",
  "audience_mismatch",
  "nonce_mismatch",
  "expired",
  "auth_time_missing",
  "auth_time_stale",
  "access_denied",
  "provider_unavailable",
] as const;
export type IdentityFailureReason = (typeof IDENTITY_FAILURE_REASONS)[number];

/** A rejected sign-in. `reason` is for logs and tests; members only ever see "failed". */
export class IdentityProviderError extends Error {
  override readonly name = "IdentityProviderError";
  readonly reason: IdentityFailureReason;

  constructor(reason: IdentityFailureReason, message?: string, options?: { cause?: unknown }) {
    super(message ?? reason, options);
    this.reason = reason;
  }
}

/** Printable ASCII (RFC 6749 VSCHAR), as issuers require for `state` and `nonce`. */
const VSCHAR = /^[\x20-\x7e]+$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Shared validation of an authorisation request: every adapter calls it first. */
export function assertAuthorizationRequest(request: OidcAuthorizationRequest): void {
  const url = URL.canParse(request.redirectUri) ? new URL(request.redirectUri) : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.hash !== "") {
    throw new IdentityProviderError(
      "invalid_request",
      "redirectUri must be an absolute http(s) URL",
    );
  }
  if (!VSCHAR.test(request.state) || request.state.length > 1024) {
    throw new IdentityProviderError("invalid_request", "state must be 1-1024 printable ASCII");
  }
  if (!VSCHAR.test(request.nonce) || request.nonce.length > 512) {
    throw new IdentityProviderError("invalid_request", "nonce must be 1-512 printable ASCII");
  }
  if (!PKCE_CHALLENGE.test(request.codeChallenge)) {
    throw new IdentityProviderError("invalid_request", "codeChallenge must be an S256 challenge");
  }
  if (
    request.maxAgeSec !== undefined &&
    (!Number.isInteger(request.maxAgeSec) || request.maxAgeSec < 0)
  ) {
    throw new IdentityProviderError("invalid_request", "maxAgeSec must be a whole number >= 0");
  }
}

/** A PKCE code verifier: 32 random bytes, base64url (43 characters). */
export function createPkceVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

/** The S256 challenge of a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8Encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Accepts the forms issuers use for `email_verified` (Apple: "true"/"false"); absent is false. */
export function normaliseEmailVerified(value: unknown): boolean {
  return value === true || value === "true";
}
