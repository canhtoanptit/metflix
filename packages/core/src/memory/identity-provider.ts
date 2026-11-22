import type { OidcProvider } from "@webflix/contracts";
import { base64UrlEncode, randomBytes } from "../encoding.ts";
import { type Clock, systemClock } from "../ports/clock.ts";
import {
  assertAuthorizationRequest,
  type IdentityProvider,
  IdentityProviderError,
  type OidcAuthorizationRequest,
  type OidcRedemption,
  pkceChallenge,
  type VerifiedIdentity,
} from "../ports/identity-provider.ts";

/** Who signs in at the in-memory issuer (the test plays both the issuer and the member). */
export interface MemorySignIn {
  email: string | null;
  emailVerified: boolean;
  name?: string | null;
  /** Misbehaviours a relying party must reject (the dev issuer's fault catalogue, in part). */
  fault?: MemoryIdentityFault;
}

export type MemoryIdentityFault = "wrong_nonce" | "stale_auth_time" | "missing_auth_time";

interface PendingCode {
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  identity: VerifiedIdentity;
  expiresAt: number;
  redeemed: boolean;
}

/**
 * In-process `IdentityProvider`: an issuer and its relying party in one object. `complete` is
 * the issuer's side (the member picked an identity); `redeem` applies every check a real
 * relying party must (single-use codes, PKCE, redirect URI, nonce, `auth_time` freshness).
 * Subjects are stable per email address, like the development issuer's typed-in personas.
 */
export class MemoryIdentityProvider implements IdentityProvider {
  readonly id: OidcProvider;
  readonly issuer: string;
  readonly displayName: string;
  readonly responseMode: "query" | "form_post";
  readonly reportsAuthTime = true;
  private readonly clock: Clock;
  private readonly codes = new Map<string, PendingCode>();
  private readonly subjects = new Map<string, string>();
  private readonly skewSec: number;

  constructor(
    options: {
      id: OidcProvider;
      issuer?: string;
      displayName?: string;
      responseMode?: "query" | "form_post";
      clock?: Clock;
      /** Allowed clock skew for `auth_time` (seconds). */
      skewSec?: number;
    } = { id: "google" },
  ) {
    this.id = options.id;
    this.issuer = options.issuer ?? `https://memory-idp.test/${options.id}`;
    this.displayName = options.displayName ?? options.id;
    this.responseMode = options.responseMode ?? (options.id === "apple" ? "form_post" : "query");
    this.clock = options.clock ?? systemClock;
    this.skewSec = options.skewSec ?? 60;
  }

  async authorizationUrl(request: OidcAuthorizationRequest): Promise<string> {
    assertAuthorizationRequest(request);
    const url = new URL(`${this.issuer}/authorize`);
    const params: Record<string, string> = {
      response_type: "code",
      client_id: `webflix-${this.id}`,
      redirect_uri: request.redirectUri,
      scope: "openid email profile",
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      response_mode: this.responseMode,
    };
    if (request.maxAgeSec !== undefined) params.max_age = String(request.maxAgeSec);
    if (request.prompt) params.prompt = request.prompt;
    if (request.loginHint) params.login_hint = request.loginHint;
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  /** The issuer's side: the member signed in at the authorisation URL. Returns the response. */
  complete(authorizationUrl: string, signIn: MemorySignIn): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const get = (name: string) => url.searchParams.get(name) ?? "";
    const now = this.clock.now();
    const subjectKey = (signIn.email ?? `anonymous-${randomBytes(4).join("")}`).toLowerCase();
    let subject = this.subjects.get(subjectKey);
    if (!subject) {
      subject = base64UrlEncode(randomBytes(12));
      this.subjects.set(subjectKey, subject);
    }
    const authTime =
      signIn.fault === "missing_auth_time"
        ? null
        : signIn.fault === "stale_auth_time"
          ? now - 24 * 60 * 60 * 1000
          : now;
    const code = base64UrlEncode(randomBytes(24));
    this.codes.set(code, {
      redirectUri: get("redirect_uri"),
      codeChallenge: get("code_challenge"),
      nonce: signIn.fault === "wrong_nonce" ? `${get("nonce")}-other` : get("nonce"),
      identity: {
        provider: this.id,
        issuer: this.issuer,
        subject,
        email: signIn.email,
        emailVerified: signIn.email !== null && signIn.emailVerified,
        name: signIn.name ?? null,
        authTime,
      },
      expiresAt: now + 60_000,
      redeemed: false,
    });
    return { code, state: get("state") };
  }

  async redeem(redemption: OidcRedemption): Promise<VerifiedIdentity> {
    const pending = this.codes.get(redemption.code);
    const now = this.clock.now();
    if (!pending || pending.redeemed || pending.expiresAt <= now) {
      throw new IdentityProviderError("invalid_grant", "unknown, used or expired code");
    }
    // A code is spent by any attempt, as at a real token endpoint.
    pending.redeemed = true;
    if (pending.redirectUri !== redemption.redirectUri) {
      throw new IdentityProviderError(
        "invalid_grant",
        "redirect_uri differs from the authorised one",
      );
    }
    if ((await pkceChallenge(redemption.codeVerifier)) !== pending.codeChallenge) {
      throw new IdentityProviderError("invalid_grant", "PKCE verifier does not match");
    }
    if (redemption.responseIssuer && redemption.responseIssuer !== this.issuer) {
      throw new IdentityProviderError("issuer_mismatch");
    }
    if (pending.nonce !== redemption.nonce) throw new IdentityProviderError("nonce_mismatch");
    const identity = pending.identity;
    if (redemption.maxAgeSec !== undefined) {
      if (identity.authTime === null) throw new IdentityProviderError("auth_time_missing");
      const ageSec = (now - identity.authTime) / 1000;
      if (ageSec > redemption.maxAgeSec + this.skewSec) {
        throw new IdentityProviderError("auth_time_stale");
      }
    }
    return { ...identity };
  }
}
