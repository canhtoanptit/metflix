/**
 * The `StaffVerifier` against a real staff issuer (milestone 2 §3, §8.3): Keycloak on Kubernetes,
 * a configured issuer on Cloudflare, the development issuer's `staff` realm locally. The admin
 * API is a resource server: it validates the console's access token offline against the issuer's
 * published keys and never sees a staff password. Web-standard APIs only (fetch, Web Crypto), so
 * the same code runs on Node and in the Worker.
 *
 * The signature is checked by the identity area's key set (`createJwksKeySet`, shared with the
 * member relying party and proven against the development issuer's fault catalogue): algorithm
 * from configuration, keys only from the issuer's JWKS by `kid`, `crit` refused, the set cached
 * with one refetch for an unknown `kid` per cooldown, trusted keys kept through an outage. The
 * set's address comes from discovery, which must name the configured issuer. On top of that, the
 * rules of an access token (RFC 9068, and Keycloak's shape, packages/dev-idp/README.md):
 * - `iss` equals the configured issuer exactly;
 * - it is an access token: claim `typ: Bearer` (Keycloak) or header `typ: at+jwt` (RFC 9068); an
 *   ID token (claim `typ: ID`, or neither marker) is refused;
 * - `aud` contains the admin API's audience (`webflix-admin-api`); other audiences may be present
 *   (Keycloak adds `account`), as RFC 9068 allows for access tokens;
 * - `exp` is required; `exp`, `nbf` and `iat` are checked with a small skew;
 * - roles: `resource_access[clientId].roles` filtered to `STAFF_ROLES` (`mapStaffRoles`).
 * An issuer that cannot be reached while no key is trusted answers `unavailable` (503), never a
 * verified identity.
 */
import { type Clock, systemClock } from "../../ports/clock.ts";
import {
  mapStaffRoles,
  type StaffIdentity,
  StaffTokenError,
  type StaffTokenFailureReason,
  type StaffVerifier,
} from "../../ports/staff-verifier.ts";
import {
  createJwksKeySet,
  fetchIssuerJson,
  type IdTokenAlgorithm,
  JwksError,
  type JwksFailure,
  type JwksFetch,
  parseJws,
} from "../identity/public.ts";

export type StaffIssuerFetch = JwksFetch;

export interface OidcStaffVerifierOptions {
  /** Exact issuer identifier (a Keycloak realm URL, `{origin}/dev-idp/staff`). */
  issuer: string;
  /** The admin API's audience. */
  audience: string;
  /** The client whose roles count (`resource_access[clientId].roles`). */
  clientId: string;
  /** Default RS256 only. */
  algorithms?: readonly IdTokenAlgorithm[];
  /** Network access to the issuer. Default: global `fetch`. The development issuer: in process. */
  fetch?: StaffIssuerFetch;
  clock?: Clock;
  /** Per call to the issuer (discovery, JWKS). Default 5000 ms. */
  timeoutMs?: number;
  /** Clock skew allowed for `exp`, `nbf`, `iat`. Default 60 s. */
  skewSec?: number;
  /** How long discovery and the JWKS are trusted before they are fetched again. Default 1 h. */
  cacheTtlSec?: number;
  /** An unknown `kid` refetches the JWKS only if the last fetch is older than this. Default 10 s. */
  jwksRefetchCooldownSec?: number;
  /** Allow an `http:` issuer (the development issuer on localhost). Default false. */
  allowHttp?: boolean;
}

const MAX_SUBJECT_LENGTH = 255;

/** How a key-set refusal reads to the staff API (the detail stays in the logs). */
const KEY_SET_REASONS: Record<JwksFailure, StaffTokenFailureReason> = {
  alg_not_allowed: "signature",
  crit_not_understood: "malformed",
  kid_missing: "malformed",
  unknown_kid: "signature",
  bad_signature: "signature",
  unavailable: "unavailable",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function refuse(reason: StaffTokenFailureReason, detail: string): never {
  throw new StaffTokenError(reason, detail);
}

/** A claim that must be a finite number when present; `malformed` otherwise. */
function numeric(claims: Record<string, unknown>, name: string): number | null {
  const value = claims[name];
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) refuse("malformed", `${name}_invalid`);
  return value;
}

function optionalString(value: unknown, max = 320): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
}

export function createOidcStaffVerifier(options: OidcStaffVerifierOptions): StaffVerifier {
  const clock = options.clock ?? systemClock;
  const fetcher: StaffIssuerFetch = options.fetch ?? ((request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? 5000;
  const skewSec = options.skewSec ?? 60;
  const cacheTtlMs = (options.cacheTtlSec ?? 3600) * 1000;
  const issuerUrl = new URL(options.issuer);
  if (issuerUrl.protocol !== "https:" && !(options.allowHttp && issuerUrl.protocol === "http:")) {
    throw new TypeError(`Staff issuer ${options.issuer} must be https`);
  }
  // Compared exactly with `iss`: no trailing slash, query, fragment or non-canonical spelling.
  if (
    options.issuer.endsWith("/") ||
    (issuerUrl.href !== options.issuer && issuerUrl.href !== `${options.issuer}/`)
  ) {
    throw new TypeError(`Staff issuer ${options.issuer} is not a canonical URL`);
  }

  let discovered: { jwksUri: string; fetchedAt: number } | null = null;

  /** The JWKS URI from discovery (cached); discovery must name the configured issuer. */
  async function jwksUri(): Promise<string> {
    const now = clock.now();
    if (discovered && now - discovered.fetchedAt < cacheTtlMs) return discovered.jwksUri;
    const { ok, status, body } = await fetchIssuerJson(
      fetcher,
      `${options.issuer}/.well-known/openid-configuration`,
      "discovery",
      timeoutMs,
    );
    if (!ok) throw new JwksError("unavailable", `discovery_status_${status}`);
    if (!isRecord(body)) throw new JwksError("unavailable", "discovery_invalid");
    // OpenID Connect Discovery §4.3: a document for another issuer is a misconfiguration (or an
    // attack); nothing it points at is trusted.
    if (body.issuer !== options.issuer) {
      throw new JwksError("unavailable", "discovery_issuer_mismatch");
    }
    const uri = body.jwks_uri;
    if (typeof uri !== "string" || !URL.canParse(uri)) {
      throw new JwksError("unavailable", "jwks_uri_invalid");
    }
    const parsed = new URL(uri);
    const allowed =
      parsed.protocol === "https:" || (options.allowHttp === true && parsed.protocol === "http:");
    if (!allowed || parsed.hash !== "") throw new JwksError("unavailable", "jwks_uri_invalid");
    discovered = { jwksUri: parsed.href, fetchedAt: now };
    return parsed.href;
  }

  const keySet = createJwksKeySet({
    jwksUri,
    algorithms: options.algorithms ?? ["RS256"],
    fetch: fetcher,
    clock,
    timeoutMs,
    cacheTtlSec: options.cacheTtlSec ?? 3600,
    refetchCooldownSec: options.jwksRefetchCooldownSec ?? 10,
  });

  return {
    async verify(token: string): Promise<StaffIdentity> {
      const jws = parseJws(token);
      if (!jws) return refuse("malformed", "not_a_jws");
      try {
        await keySet.verify(jws);
      } catch (error) {
        if (error instanceof JwksError) refuse(KEY_SET_REASONS[error.reason], error.message);
        throw error;
      }
      const claims = jws.payload;

      if (claims.iss !== options.issuer) refuse("issuer", "iss_mismatch");
      // Before the audience: an ID token handed over as an access token is named for what it is.
      const headerType =
        typeof jws.header.typ === "string" ? jws.header.typ.toLowerCase() : undefined;
      const accessToken =
        claims.typ === "Bearer" || headerType === "at+jwt" || headerType === "application/at+jwt";
      if (!accessToken) refuse("token_type", "not_an_access_token");
      const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      if (!Array.isArray(audiences) || !audiences.includes(options.audience)) {
        refuse("audience", "aud_mismatch");
      }

      const nowSec = clock.now() / 1000;
      const exp = numeric(claims, "exp");
      const nbf = numeric(claims, "nbf");
      const iat = numeric(claims, "iat");
      if (exp === null) refuse("malformed", "exp_missing");
      if (exp + skewSec <= nowSec) refuse("expired", "expired");
      if (nbf !== null && nbf - skewSec > nowSec) refuse("not_yet_valid", "nbf_in_future");
      if (iat !== null && iat - skewSec > nowSec) refuse("not_yet_valid", "issued_in_future");

      const subject = claims.sub;
      if (
        typeof subject !== "string" ||
        subject.length === 0 ||
        subject.length > MAX_SUBJECT_LENGTH
      ) {
        refuse("malformed", "sub_invalid");
      }
      return {
        subject,
        name: optionalString(claims.name, 200),
        email: optionalString(claims.email),
        roles: mapStaffRoles(claims, options.clientId),
        expiresAt: Math.floor(exp * 1000),
      };
    },
  };
}
