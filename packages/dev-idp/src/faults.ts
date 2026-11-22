/**
 * Fault injection: each fault is one named option that makes the issuer misbehave in exactly one
 * way a relying party must survive. The catalogue below is the single source for the names, the
 * sign-in page's fault picker and the README.
 *
 * Where a fault applies:
 * - `token`: a signed token in the token response; `target` picks the ID token (default), the
 *   access token (when it is a JWT) or both.
 * - `id_token`: a claim only the ID token carries.
 * - `identity`: the identity the flow asserts, in the ID token, access token and userinfo alike.
 * - `response`: the token response as a whole.
 * - `authorization`: the authorisation response delivered to the redirect URI.
 * - `endpoint`: a whole endpoint, for every caller; only `idp.faults.set` can turn these on.
 */

export type FaultScope =
  | "token"
  | "id_token"
  | "identity"
  | "response"
  | "authorization"
  | "endpoint";

export interface FaultDefinition {
  readonly scope: FaultScope;
  /** A few words for the sign-in page. */
  readonly label: string;
  /** What the issuer does. */
  readonly provider: string;
  /** What a correct relying party does. */
  readonly relyingParty: string;
  /** Needs a store (`codeReplay`): unavailable when the issuer runs without one. */
  readonly needsStore?: boolean;
}

export const FAULT_CATALOGUE = {
  unknownKey: {
    scope: "token",
    label: "Signed by an unknown key",
    provider:
      "Signs with a key that was never published, under a kid no JWKS of this issuer lists.",
    relyingParty:
      "Refetch the JWKS at most once for an unknown kid (rate limited), still find no key, reject.",
  },
  removedKey: {
    scope: "token",
    label: "Signed by a key removed from the JWKS",
    provider:
      "Signs with a key the issuer used to publish and has since removed from its JWKS (a revoked key).",
    relyingParty:
      "Reject once its JWKS cache is refreshed; never keep trusting a kid the current JWKS lacks beyond its cache lifetime.",
  },
  algNone: {
    scope: "token",
    label: "alg: none (unsigned)",
    provider: "Sends an Unsecured JWS: header alg none, empty signature.",
    relyingParty:
      "Reject: only the algorithms configured for this issuer (RS256, ES256) are acceptable.",
  },
  hmacKeyConfusion: {
    scope: "token",
    label: "HMAC with the public key as secret",
    provider:
      "Header alg HS256 with the kid of the current public key; the MAC is keyed with that public key's PEM (SubjectPublicKeyInfo, trailing newline).",
    relyingParty:
      "Reject: choose the algorithm from configuration and the key type, never from the token header.",
  },
  embeddedJwk: {
    scope: "token",
    label: "Key embedded in the header",
    provider:
      "Signs with an unpublished key and puts its public half in the header's jwk member (jku and x5u are not used).",
    relyingParty: "Ignore keys carried by the token; verify only with the issuer's JWKS.",
  },
  wrongIssuer: {
    scope: "token",
    label: "Wrong iss",
    provider: "Signs correctly, with iss set to another issuer (this issuer's URL plus -mixup).",
    relyingParty: "Reject unless iss equals the configured issuer exactly.",
  },
  wrongAudience: {
    scope: "token",
    label: "Wrong aud",
    provider: "Signs correctly, with aud naming another client.",
    relyingParty:
      "Reject unless aud contains its own client id (or, for access tokens, its resource).",
  },
  extraAudience: {
    scope: "token",
    label: "An extra, untrusted aud",
    provider: "aud is an array: the right client and another one; azp names the right client.",
    relyingParty:
      "Reject an ID token whose aud lists audiences it does not trust (OpenID Connect Core §3.1.3.7).",
  },
  expired: {
    scope: "token",
    label: "Expired",
    provider: "iat one hour ago, exp ten minutes ago: beyond any reasonable clock-skew allowance.",
    relyingParty: "Reject (allow at most a small, configured skew).",
  },
  notYetValid: {
    scope: "token",
    label: "Not yet valid",
    provider: "iat and nbf ten minutes in the future.",
    relyingParty: "Reject tokens issued or valid in the future beyond the configured skew.",
  },
  wrongNonce: {
    scope: "id_token",
    label: "Wrong nonce",
    provider: "The ID token carries a nonce other than the one in the authorisation request.",
    relyingParty: "Reject: the nonce must equal the one bound to this browser's transaction.",
  },
  missingNonce: {
    scope: "id_token",
    label: "Missing nonce",
    provider: "The ID token has no nonce although the request sent one.",
    relyingParty: "Reject when a nonce was sent and the ID token lacks it.",
  },
  wrongAtHash: {
    scope: "id_token",
    label: "Wrong at_hash",
    provider: "at_hash is the hash of a different access token.",
    relyingParty:
      "When at_hash is present, recompute it over the access token received and reject a mismatch.",
  },
  staleAuthTime: {
    scope: "id_token",
    label: "auth_time older than max_age",
    provider:
      "auth_time is one day old even when the request asked for max_age (for example max_age=0).",
    relyingParty:
      "When it sent max_age, reject unless now - auth_time <= max_age (plus skew); never treat it as a fresh sign-in.",
  },
  missingAuthTime: {
    scope: "id_token",
    label: "auth_time missing",
    provider: "The ID token omits auth_time even when the request sent max_age.",
    relyingParty: "When it sent max_age, reject an ID token without auth_time.",
  },
  emailUnverified: {
    scope: "identity",
    label: "email_verified false",
    provider: "Asserts the persona's email with email_verified false.",
    relyingParty:
      "Never link to or sign in an existing account by this email; continue sign-up or require proof.",
  },
  emailVerifiedAbsent: {
    scope: "identity",
    label: "email_verified absent",
    provider: "Asserts the email without an email_verified claim.",
    relyingParty: "Treat an absent email_verified as false.",
  },
  subjectChanged: {
    scope: "identity",
    label: "Different sub, same email",
    provider: "Issues a different sub for the persona while keeping its email.",
    relyingParty:
      "Key identities by (iss, sub) only; a new sub with a known email is a new identity, linked only under the verified-email rule.",
  },
  idTokenAsAccessToken: {
    scope: "response",
    label: "ID token returned as the access token",
    provider: "The token response's access_token is the ID token itself.",
    relyingParty:
      "A resource server rejects it: an ID token is not an access token (check typ, aud, and the token's purpose).",
  },
  jwksRotatedMidFlow: {
    scope: "response",
    label: "Keys rotated mid-flow",
    provider:
      "Signs this response's tokens with a brand-new key that no JWKS listed until now; the JWKS lists it from this moment (on this instance; at most two such keys per algorithm). Other tokens keep the current key.",
    relyingParty:
      "On an unknown kid, refetch the JWKS once and accept the token if the key is now published.",
  },
  codeForAnotherClient: {
    scope: "authorization",
    label: "Code issued to another client",
    provider:
      "The authorisation response carries a code minted for a different client; the token endpoint refuses it (invalid_grant).",
    relyingParty: "Show a failed sign-in; do not retry the code or fall back to anything else.",
  },
  codeReplay: {
    scope: "authorization",
    label: "Code already redeemed",
    provider:
      "The authorisation response carries a code that was already redeemed; the token endpoint refuses it (invalid_grant).",
    relyingParty:
      "Show a failed sign-in. Its own callback must also refuse to process the same authorisation response twice.",
    needsStore: true,
  },
  pkceMismatch: {
    scope: "authorization",
    label: "PKCE verifier mismatch",
    provider:
      "The code is bound to a different code_challenge (an injected code); the token endpoint refuses the relying party's verifier.",
    relyingParty: "Show a failed sign-in; never retry without PKCE.",
  },
  tamperedState: {
    scope: "authorization",
    label: "Tampered state",
    provider: "The authorisation response returns a state that differs from the one sent.",
    relyingParty: "Reject before redeeming the code: state must match this browser's transaction.",
  },
  wrongResponseIssuer: {
    scope: "authorization",
    label: "Wrong iss in the response (RFC 9207)",
    provider: "The authorisation response's iss parameter names another issuer.",
    relyingParty:
      "When the issuer advertises authorization_response_iss_parameter_supported, reject a response whose iss differs.",
  },
  discoveryIssuerMismatch: {
    scope: "endpoint",
    label: "Discovery names another issuer",
    provider: "The discovery document's issuer differs from the URL it was fetched from.",
    relyingParty:
      "Refuse the configuration (OpenID Connect Discovery §4.3); do not sign anyone in.",
  },
  jwksSlow: {
    scope: "endpoint",
    label: "Slow JWKS",
    provider: "The JWKS endpoint answers after delayMs (default 5000).",
    relyingParty:
      "Time out, fail the sign-in cleanly, and keep serving everything that does not need the issuer.",
  },
  jwksFailing: {
    scope: "endpoint",
    label: "Failing JWKS",
    provider: "The JWKS endpoint answers with an error status (default 503).",
    relyingParty:
      "Fail the sign-in; keep using a cached JWKS for known kids; never accept a token it could not verify.",
  },
  userinfoSubjectMismatch: {
    scope: "endpoint",
    label: "Userinfo sub differs",
    provider: "The userinfo endpoint answers with a sub other than the ID token's.",
    relyingParty: "Discard the userinfo response (OpenID Connect Core §5.3.2).",
  },
} as const satisfies Record<string, FaultDefinition>;

export type FaultName = keyof typeof FAULT_CATALOGUE;
export const FAULT_NAMES = Object.keys(FAULT_CATALOGUE) as FaultName[];

export type TokenTarget = "id_token" | "access_token" | "both";
type Targeted = true | { target: TokenTarget };

/** The faults to inject, one named option each. */
export interface DevIdpFaults {
  unknownKey?: Targeted;
  removedKey?: Targeted;
  algNone?: Targeted;
  hmacKeyConfusion?: Targeted;
  embeddedJwk?: Targeted;
  wrongIssuer?: Targeted;
  wrongAudience?: Targeted;
  extraAudience?: Targeted;
  expired?: Targeted;
  notYetValid?: Targeted;
  wrongNonce?: true;
  missingNonce?: true;
  wrongAtHash?: true;
  staleAuthTime?: true;
  missingAuthTime?: true;
  emailUnverified?: true;
  emailVerifiedAbsent?: true;
  subjectChanged?: true;
  idTokenAsAccessToken?: true;
  jwksRotatedMidFlow?: true;
  codeForAnotherClient?: true;
  codeReplay?: true;
  pkceMismatch?: true;
  tamperedState?: true;
  wrongResponseIssuer?: true;
  discoveryIssuerMismatch?: true;
  jwksSlow?: true | { delayMs: number };
  jwksFailing?: true | { status: number };
  userinfoSubjectMismatch?: true;
}

export function isFaultName(value: string): value is FaultName {
  return Object.hasOwn(FAULT_CATALOGUE, value);
}

export function isFlowFault(name: FaultName): boolean {
  return FAULT_CATALOGUE[name].scope !== "endpoint";
}

const TARGETS: readonly TokenTarget[] = ["id_token", "access_token", "both"];

/** Validates a fault set and returns a copy. Throws `TypeError` on anything unknown. */
export function normalizeFaults(faults: DevIdpFaults): DevIdpFaults {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(faults)) {
    if (value === undefined || value === false) continue;
    if (!isFaultName(name)) throw new TypeError(`Unknown fault "${name}"`);
    const scope = FAULT_CATALOGUE[name].scope;
    if (value === true) {
      out[name] = true;
    } else if (scope === "token" && typeof value === "object" && TARGETS.includes(value.target)) {
      out[name] = { target: value.target };
    } else if (name === "jwksSlow" && typeof value === "object" && "delayMs" in value) {
      const { delayMs } = value;
      if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 120_000) {
        throw new TypeError("jwksSlow.delayMs must be an integer from 0 to 120000");
      }
      out[name] = { delayMs };
    } else if (name === "jwksFailing" && typeof value === "object" && "status" in value) {
      const { status } = value;
      if (!Number.isInteger(status) || status < 400 || status > 599) {
        throw new TypeError("jwksFailing.status must be an HTTP error status (400-599)");
      }
      out[name] = { status };
    } else {
      throw new TypeError(`Invalid value for fault "${name}"`);
    }
  }
  return out as DevIdpFaults;
}

/**
 * Flow faults in their compact form (`name` or `name:target`), as the sign-in page posts them and
 * as sealed codes carry them. Returns null when any entry is invalid or not a flow fault.
 */
export function parseFlowFaults(entries: readonly string[]): DevIdpFaults | null {
  const faults: Record<string, unknown> = {};
  for (const entry of entries) {
    const [name = "", target, extra] = entry.split(":");
    if (extra !== undefined || !isFaultName(name) || !isFlowFault(name)) return null;
    if (target === undefined) {
      faults[name] = true;
    } else if (FAULT_CATALOGUE[name].scope === "token" && TARGETS.includes(target as TokenTarget)) {
      faults[name] = { target };
    } else {
      return null;
    }
  }
  return faults as DevIdpFaults;
}

export function serializeFlowFaults(faults: DevIdpFaults): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(faults)) {
    if (!value || !isFaultName(name) || !isFlowFault(name)) continue;
    out.push(typeof value === "object" && "target" in value ? `${name}:${value.target}` : name);
  }
  return out;
}

/** Does a token fault apply to this token? */
export function targets(value: Targeted | undefined, token: "id_token" | "access_token"): boolean {
  if (value === undefined) return false;
  const target = value === true ? "id_token" : value.target;
  return target === "both" || target === token;
}

/** Merges standing faults with a flow's own (the flow's win). */
export function mergeFaults(standing: DevIdpFaults, flow: DevIdpFaults): DevIdpFaults {
  return { ...standing, ...flow };
}
