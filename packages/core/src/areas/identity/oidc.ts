/**
 * The generic OpenID Connect relying party (milestone 2 §3, §4.1): one `IdentityProvider` per
 * configured issuer (Google, Apple, Keycloak, or the development issuer standing in for them).
 * Web-standard APIs only (fetch, Web Crypto), so the same code signs members in on Node and in
 * the Worker.
 *
 * Written from the specifications (OpenID Connect Core 1.0 §3.1.3.7, Discovery 1.0 §4.3, RFC 7636,
 * RFC 9207) for a hostile issuer response; every rule below is exercised by a failing case of
 * the development issuer's fault catalogue (packages/dev-idp/README.md):
 * - discovery: `issuer` must equal the configured issuer exactly;
 * - the authorisation response's `iss` (RFC 9207) must equal it when present, and be present when
 *   the issuer advertises it;
 * - the token response must carry an ID token, and its access token must not be that ID token;
 * - the ID token's algorithm comes from configuration (RS256, ES256), never from its header; the
 *   key comes only from the issuer's JWKS by `kid` (keys in the token are ignored); an unknown
 *   `kid` refetches the JWKS once (with a cooldown) and is refused if still unknown;
 * - `iss`, `aud` (only this client), `azp`, `exp`, `iat`, `nbf` (with a small skew), `nonce`,
 *   `at_hash` when present, `auth_time` when `max_age` was sent (absent: fails closed);
 * - `email_verified` is a boolean or Apple's string; absent means unverified.
 * The access token is never used: only the validated ID token decides who signed in.
 */
import type { OidcProvider } from "@webflix/contracts";
import { timingSafeEqual, utf8Encode } from "../../encoding.ts";
import { type Clock, systemClock } from "../../ports/clock.ts";
import {
  assertAuthorizationRequest,
  type IdentityFailureReason,
  type IdentityProvider,
  IdentityProviderError,
  normaliseEmailVerified,
  type OidcAuthorizationRequest,
  type OidcRedemption,
  type VerifiedIdentity,
} from "../../ports/identity-provider.ts";
import {
  accessTokenHash,
  type Es256PrivateKey,
  type IdTokenAlgorithm,
  importEs256SigningKey,
  type ParsedJws,
  parseJws,
  signEs256,
} from "./jose.ts";
import { createJwksKeySet, fetchIssuerJson, JwksError } from "./jwks.ts";

export type OidcFetch = (request: Request) => Promise<Response>;

/** How the client authenticates at the token endpoint. */
export type OidcClientAuthentication =
  | { method: "client_secret_basic" | "client_secret_post"; secret: string }
  /** Apple: `client_secret_post` with an ES256 JWT signed by the team's key (§4.1). */
  | { method: "apple_client_secret"; teamId: string; keyId: string; privateKey: Es256PrivateKey }
  | { method: "none" };

export interface OidcProviderOptions {
  id: OidcProvider;
  displayName: string;
  /** Exact issuer identifier: discovery and every ID token must name it. */
  issuer: string;
  clientId: string;
  clientAuthentication: OidcClientAuthentication;
  /** Default `openid email profile`. Apple: `openid email name`. */
  scopes?: readonly string[];
  /** `form_post` for Apple (a cross-site POST to the callback). Default `query`. */
  responseMode?: "query" | "form_post";
  /** Default RS256 only. */
  algorithms?: readonly IdTokenAlgorithm[];
  /**
   * Whether this issuer is known to send `auth_time`, so that a fresh sign-in is offered as the
   * account-holder proof (§4.2). A fresh sign-in is still judged by `auth_time` alone.
   */
  reportsAuthTime?: boolean;
  /** Network access to the issuer. Default: global `fetch`. The development issuer: in process. */
  fetch?: OidcFetch;
  clock?: Clock;
  /** Per call to the issuer (discovery, JWKS, token). Default 5000 ms. */
  timeoutMs?: number;
  /** Clock skew allowed for `exp`, `iat`, `nbf`, `auth_time`. Default 60 s. */
  skewSec?: number;
  /** How long discovery and the JWKS are trusted before they are fetched again. Default 1 h. */
  cacheTtlSec?: number;
  /** An unknown `kid` refetches the JWKS only if the last fetch is older than this. Default 10 s. */
  jwksRefetchCooldownSec?: number;
  /** Allow an `http:` issuer (the development issuer on localhost). Default false. */
  allowHttp?: boolean;
}

interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  issParameterSupported: boolean;
}

const MAX_SUBJECT_LENGTH = 255;
const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

function fail(reason: IdentityFailureReason, detail: string, cause?: unknown): never {
  throw new IdentityProviderError(reason, detail, cause === undefined ? undefined : { cause });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function equalsConstantTime(a: string, b: string): boolean {
  const left = utf8Encode(a);
  const right = utf8Encode(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** RFC 6749 §2.3.1: client id and secret are form-urlencoded before Basic encoding. */
function basicCredentials(clientId: string, secret: string): string {
  const form = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
  const raw = utf8Encode(`${form(clientId)}:${form(secret)}`);
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

export function createOidcIdentityProvider(options: OidcProviderOptions): IdentityProvider {
  const clock = options.clock ?? systemClock;
  const fetcher: OidcFetch = options.fetch ?? ((request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? 5000;
  const skewSec = options.skewSec ?? 60;
  const cacheTtlMs = (options.cacheTtlSec ?? 3600) * 1000;
  const scopes = options.scopes ?? ["openid", "email", "profile"];
  const responseMode = options.responseMode ?? "query";
  if (!scopes.includes("openid")) throw new TypeError("OpenID scopes must include openid");
  const issuerUrl = new URL(options.issuer);
  if (issuerUrl.protocol !== "https:" && !(options.allowHttp && issuerUrl.protocol === "http:")) {
    throw new TypeError(`Issuer ${options.issuer} must be https`);
  }

  let discovery: { value: Discovery; fetchedAt: number } | null = null;
  let appleKey: Promise<CryptoKey> | null = null;

  /** One JSON document from the issuer (deadline, size cap); `provider_unavailable` otherwise. */
  async function issuerJson(
    url: string,
    what: string,
    // `RequestInit`, not a derived type: Workers' declarations make `Request` generic over it.
    init: RequestInit = {},
  ): Promise<{ status: number; ok: boolean; body: unknown }> {
    try {
      return await fetchIssuerJson(fetcher, url, what, timeoutMs, init);
    } catch (error) {
      if (error instanceof JwksError) return fail("provider_unavailable", error.message, error);
      throw error;
    }
  }

  function endpoint(value: unknown, name: string): string {
    if (typeof value !== "string" || !URL.canParse(value)) {
      fail("provider_unavailable", `discovery_${name}_invalid`);
    }
    const url = new URL(value);
    const allowed = url.protocol === "https:" || (options.allowHttp && url.protocol === "http:");
    if (!allowed || url.hash !== "") fail("provider_unavailable", `discovery_${name}_invalid`);
    return url.href;
  }

  async function metadata(): Promise<Discovery> {
    const now = clock.now();
    if (discovery && now - discovery.fetchedAt < cacheTtlMs) return discovery.value;
    const answer = await issuerJson(
      `${options.issuer}/.well-known/openid-configuration`,
      "discovery",
    );
    if (!answer.ok) fail("provider_unavailable", `discovery_status_${answer.status}`);
    const document = answer.body;
    if (!isRecord(document)) return fail("provider_unavailable", "discovery_invalid");
    // OpenID Connect Discovery §4.3: the issuer in the document must be the one configured.
    if (document.issuer !== options.issuer) fail("issuer_mismatch", "discovery_issuer_mismatch");
    const value: Discovery = {
      issuer: options.issuer,
      authorizationEndpoint: endpoint(document.authorization_endpoint, "authorization_endpoint"),
      tokenEndpoint: endpoint(document.token_endpoint, "token_endpoint"),
      jwksUri: endpoint(document.jwks_uri, "jwks_uri"),
      issParameterSupported: document.authorization_response_iss_parameter_supported === true,
    };
    discovery = { value, fetchedAt: now };
    return value;
  }

  // The issuer's keys: one implementation for every verifier (jwks.ts).
  const keySet = createJwksKeySet({
    jwksUri: async () => (await metadata()).jwksUri,
    algorithms: options.algorithms ?? ["RS256"],
    fetch: fetcher,
    clock,
    timeoutMs,
    cacheTtlSec: options.cacheTtlSec ?? 3600,
    refetchCooldownSec: options.jwksRefetchCooldownSec ?? 10,
  });

  async function verifySignature(jws: ParsedJws): Promise<void> {
    try {
      await keySet.verify(jws);
    } catch (error) {
      if (!(error instanceof JwksError)) throw error;
      fail(
        error.reason === "unavailable" ? "provider_unavailable" : "invalid_token",
        error.message,
        error,
      );
    }
  }

  function numericClaim(claims: Record<string, unknown>, name: string): number | null {
    const value = claims[name];
    if (value === undefined) return null;
    if (typeof value !== "number" || !Number.isFinite(value))
      fail("invalid_token", `${name}_invalid`);
    return value;
  }

  async function validateIdToken(
    idToken: string,
    accessToken: string | null,
    redemption: OidcRedemption,
  ): Promise<VerifiedIdentity> {
    const jws = parseJws(idToken);
    if (!jws) return fail("invalid_token", "id_token_malformed");
    await verifySignature(jws);
    const claims = jws.payload;
    const nowSec = clock.now() / 1000;

    if (claims.iss !== options.issuer) fail("issuer_mismatch", "iss_mismatch");
    // Only this client may be an audience (Core §3.1.3.7): another, untrusted one is refused.
    const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
    if (!Array.isArray(audiences) || !audiences.includes(options.clientId)) {
      fail("audience_mismatch", "aud_mismatch");
    }
    if (audiences.some((audience) => audience !== options.clientId)) {
      fail("audience_mismatch", "untrusted_audience");
    }
    if (claims.azp !== undefined && claims.azp !== options.clientId) {
      fail("audience_mismatch", "azp_mismatch");
    }

    const exp = numericClaim(claims, "exp");
    const iat = numericClaim(claims, "iat");
    const nbf = numericClaim(claims, "nbf");
    if (exp === null || iat === null) fail("invalid_token", "exp_or_iat_missing");
    if (exp + skewSec <= nowSec) fail("expired", "expired");
    if (iat - skewSec > nowSec) fail("invalid_token", "issued_in_future");
    if (nbf !== null && nbf - skewSec > nowSec) fail("invalid_token", "not_yet_valid");

    // The nonce bound to this browser's transaction (compared in constant time).
    if (typeof claims.nonce !== "string") fail("nonce_mismatch", "nonce_missing");
    if (!equalsConstantTime(claims.nonce, redemption.nonce))
      fail("nonce_mismatch", "nonce_mismatch");

    if (claims.at_hash !== undefined) {
      if (typeof claims.at_hash !== "string" || accessToken === null) {
        fail("invalid_token", "at_hash_mismatch");
      }
      if (!equalsConstantTime(claims.at_hash, await accessTokenHash(accessToken))) {
        fail("invalid_token", "at_hash_mismatch");
      }
    }

    const authTime = numericClaim(claims, "auth_time");
    if (authTime !== null && authTime - skewSec > nowSec) fail("invalid_token", "auth_time_future");
    if (redemption.maxAgeSec !== undefined) {
      // A fresh sign-in is judged by auth_time alone; an issuer that omits it fails closed.
      if (authTime === null) fail("auth_time_missing", "auth_time_missing");
      if (nowSec - authTime > redemption.maxAgeSec + skewSec)
        fail("auth_time_stale", "auth_too_old");
    }

    const subject = claims.sub;
    if (
      typeof subject !== "string" ||
      subject.length === 0 ||
      subject.length > MAX_SUBJECT_LENGTH
    ) {
      fail("invalid_token", "sub_invalid");
    }
    const rawEmail = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : null;
    const email =
      rawEmail !== null && rawEmail.length <= 254 && EMAIL.test(rawEmail) ? rawEmail : null;
    const name =
      typeof claims.name === "string" && claims.name.trim() !== ""
        ? claims.name.trim().slice(0, 200)
        : null;
    return {
      provider: options.id,
      issuer: options.issuer,
      subject,
      email,
      emailVerified: email !== null && normaliseEmailVerified(claims.email_verified),
      name,
      authTime: authTime === null ? null : authTime * 1000,
    };
  }

  async function clientAuthentication(
    meta: Discovery,
  ): Promise<{ headers: Record<string, string>; body: Record<string, string> }> {
    const auth = options.clientAuthentication;
    switch (auth.method) {
      case "client_secret_basic":
        return {
          headers: { Authorization: basicCredentials(options.clientId, auth.secret) },
          body: {},
        };
      case "client_secret_post":
        return { headers: {}, body: { client_id: options.clientId, client_secret: auth.secret } };
      case "apple_client_secret": {
        appleKey ??= importEs256SigningKey(auth.privateKey);
        const nowSec = Math.floor(clock.now() / 1000);
        const secret = await signEs256(
          { kid: auth.keyId },
          {
            iss: auth.teamId,
            sub: options.clientId,
            aud: meta.issuer,
            iat: nowSec,
            exp: nowSec + 300,
          },
          await appleKey,
        );
        return { headers: {}, body: { client_id: options.clientId, client_secret: secret } };
      }
      case "none":
        return { headers: {}, body: { client_id: options.clientId } };
    }
  }

  return {
    id: options.id,
    issuer: options.issuer,
    displayName: options.displayName,
    responseMode,
    reportsAuthTime: options.reportsAuthTime ?? false,

    async authorizationUrl(request: OidcAuthorizationRequest): Promise<string> {
      assertAuthorizationRequest(request);
      const meta = await metadata();
      const url = new URL(meta.authorizationEndpoint);
      const params: Record<string, string> = {
        response_type: "code",
        client_id: options.clientId,
        redirect_uri: request.redirectUri,
        scope: scopes.join(" "),
        state: request.state,
        nonce: request.nonce,
        code_challenge: request.codeChallenge,
        code_challenge_method: "S256",
      };
      if (responseMode === "form_post") params.response_mode = "form_post";
      if (request.maxAgeSec !== undefined) params.max_age = String(request.maxAgeSec);
      if (request.prompt) params.prompt = request.prompt;
      if (request.loginHint) params.login_hint = request.loginHint;
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      return url.href;
    },

    async redeem(redemption: OidcRedemption): Promise<VerifiedIdentity> {
      const meta = await metadata();
      // RFC 9207: an authorisation response from another issuer (mix-up) is refused before the
      // code goes anywhere.
      if (redemption.responseIssuer != null && redemption.responseIssuer !== meta.issuer) {
        fail("issuer_mismatch", "response_iss_mismatch");
      }
      if (meta.issParameterSupported && redemption.responseIssuer == null) {
        fail("issuer_mismatch", "response_iss_missing");
      }
      const auth = await clientAuthentication(meta);
      const response = await issuerJson(meta.tokenEndpoint, "token_response", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          ...auth.headers,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: redemption.code,
          redirect_uri: redemption.redirectUri,
          code_verifier: redemption.codeVerifier,
          ...auth.body,
        }).toString(),
      });
      const body = response.body;
      if (!response.ok) {
        const error = isRecord(body) && typeof body.error === "string" ? body.error : "unknown";
        if (response.status >= 500) fail("provider_unavailable", `token_status_${response.status}`);
        fail(
          error === "invalid_grant" ? "invalid_grant" : "invalid_request",
          `token_error:${error}`,
        );
      }
      if (!isRecord(body)) return fail("invalid_token", "token_response_invalid");
      const idToken = body.id_token;
      if (typeof idToken !== "string") return fail("invalid_token", "id_token_missing");
      const accessToken = typeof body.access_token === "string" ? body.access_token : null;
      if (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer") {
        fail("invalid_token", "token_type_invalid");
      }
      // An ID token is not an access token: a response that hands one out as the other is
      // malformed, whatever else it says.
      if (accessToken !== null && accessToken === idToken) {
        fail("invalid_token", "id_token_as_access_token");
      }
      return validateIdToken(idToken, accessToken, redemption);
    },
  };
}
