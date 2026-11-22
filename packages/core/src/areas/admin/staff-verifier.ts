/**
 * The `StaffVerifier` against a real staff issuer (milestone 2 §3, §8.3): Keycloak on Kubernetes,
 * a configured issuer on Cloudflare, the development issuer's `staff` realm locally. The admin
 * API is a resource server: it validates the console's access token offline against the issuer's
 * published keys and never sees a staff password. Web-standard APIs only (fetch, Web Crypto), so
 * the same code runs on Node and in the Worker.
 *
 * JOSE is the identity area's (`parseJws`, `importVerificationKey`, `verifyJwsSignature`, proven
 * against the development issuer's fault catalogue): the algorithm comes from configuration and
 * the key's type, never from the token header; keys a token carries (`jwk`, `jku`, `x5u`, `x5c`)
 * are never looked at. On top of that, the rules of an access token (RFC 9068, and Keycloak's
 * shape, packages/dev-idp/README.md):
 * - `iss` equals the configured issuer exactly; discovery must name the same issuer;
 * - `aud` contains the admin API's audience (`webflix-admin-api`); other audiences may be present
 *   (Keycloak adds `account`), as RFC 9068 allows for access tokens;
 * - it is an access token: claim `typ: Bearer` (Keycloak) or header `typ: at+jwt` (RFC 9068); an
 *   ID token (claim `typ: ID`, or neither marker) is refused;
 * - `exp` is required; `exp`, `nbf` and `iat` are checked with a small skew;
 * - a header with `crit` is refused (no extension is understood);
 * - roles: `resource_access[clientId].roles` filtered to `STAFF_ROLES` (`mapStaffRoles`).
 * Keys: discovery and the JWKS are cached; an unknown `kid` refetches the JWKS once (at most once
 * per cooldown) and is refused if still unknown; an issuer outage keeps the keys already trusted
 * and, with none, answers `unavailable` (503), never a verified identity.
 */
import { utf8Decode } from "../../encoding.ts";
import { type Clock, systemClock } from "../../ports/clock.ts";
import {
  mapStaffRoles,
  type StaffIdentity,
  StaffTokenError,
  type StaffVerifier,
} from "../../ports/staff-verifier.ts";
import {
  type IdTokenAlgorithm,
  importVerificationKey,
  type ParsedJws,
  type PublicJwk,
  parseJws,
  verifyJwsSignature,
} from "../identity/jose.ts";

export type StaffIssuerFetch = (request: Request) => Promise<Response>;

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

interface CachedJwks {
  keys: PublicJwk[];
  fetchedAt: number;
  imported: Map<string, CryptoKey | null>;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SUBJECT_LENGTH = 255;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function refuse(reason: ConstructorParameters<typeof StaffTokenError>[0], detail: string): never {
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
  const cooldownMs = (options.jwksRefetchCooldownSec ?? 10) * 1000;
  const algorithms = new Set<IdTokenAlgorithm>(options.algorithms ?? ["RS256"]);
  if (algorithms.size === 0) throw new TypeError("At least one staff token algorithm is needed");
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

  let jwksUri: { value: string; fetchedAt: number } | null = null;
  let jwks: CachedJwks | null = null;
  // One fetch at a time: concurrent requests on a cold cache share it.
  let inflight: Promise<CachedJwks> | null = null;

  async function call(url: string): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // An in-process issuer ignores abort signals: race the deadline as well.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new StaffTokenError("unavailable", "issuer_timeout"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        fetcher(
          new Request(url, { headers: { Accept: "application/json" }, signal: controller.signal }),
        ),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof StaffTokenError) throw error;
      return refuse("unavailable", "issuer_unreachable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function readJson(response: Response, what: string): Promise<unknown> {
    if (!response.ok) refuse("unavailable", `${what}_status_${response.status}`);
    const declared = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      refuse("unavailable", `${what}_too_large`);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          refuse("unavailable", `${what}_too_large`);
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(utf8Decode(bytes));
    } catch {
      return refuse("unavailable", `${what}_not_json`);
    }
  }

  /** The JWKS URI from discovery (cached); discovery must name the configured issuer. */
  async function discoverJwksUri(): Promise<string> {
    const now = clock.now();
    if (jwksUri && now - jwksUri.fetchedAt < cacheTtlMs) return jwksUri.value;
    const document = await readJson(
      await call(`${options.issuer}/.well-known/openid-configuration`),
      "discovery",
    );
    if (!isRecord(document)) return refuse("unavailable", "discovery_invalid");
    // OpenID Connect Discovery §4.3: a document for another issuer is a misconfiguration (or an
    // attack); nothing it points at is trusted.
    if (document.issuer !== options.issuer) refuse("unavailable", "discovery_issuer_mismatch");
    const uri = document.jwks_uri;
    if (typeof uri !== "string" || !URL.canParse(uri)) refuse("unavailable", "jwks_uri_invalid");
    const parsed = new URL(uri);
    const allowed =
      parsed.protocol === "https:" || (options.allowHttp && parsed.protocol === "http:");
    if (!allowed || parsed.hash !== "") refuse("unavailable", "jwks_uri_invalid");
    jwksUri = { value: parsed.href, fetchedAt: now };
    return parsed.href;
  }

  async function fetchJwks(): Promise<CachedJwks> {
    inflight ??= (async () => {
      const document = await readJson(await call(await discoverJwksUri()), "jwks");
      if (!isRecord(document) || !Array.isArray(document.keys)) {
        return refuse("unavailable", "jwks_invalid");
      }
      const keys = document.keys.filter(
        (key): key is PublicJwk => isRecord(key) && typeof key.kty === "string",
      );
      jwks = { keys, fetchedAt: clock.now(), imported: new Map() };
      return jwks;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  /** The current key set: cached, refreshed when stale; a failed refresh keeps trusted keys. */
  async function currentJwks(): Promise<CachedJwks> {
    if (jwks && clock.now() - jwks.fetchedAt < cacheTtlMs) return jwks;
    try {
      return await fetchJwks();
    } catch (error) {
      // An issuer outage must not lock staff out of keys already trusted; with none, fail.
      if (jwks) return jwks;
      throw error;
    }
  }

  async function keyFor(cache: CachedJwks, kid: string, alg: IdTokenAlgorithm) {
    const cacheKey = `${alg}\u0000${kid}`;
    if (cache.imported.has(cacheKey)) return cache.imported.get(cacheKey) ?? null;
    const jwk = cache.keys.find((candidate) => candidate.kid === kid);
    const key = jwk ? await importVerificationKey(jwk, alg) : null;
    cache.imported.set(cacheKey, key);
    return key;
  }

  async function verifySignature(jws: ParsedJws): Promise<void> {
    const alg = jws.header.alg;
    // `none`, HS256 keyed with a public key, or anything else the header claims is refused
    // before any key is looked at.
    if (typeof alg !== "string" || !algorithms.has(alg as IdTokenAlgorithm)) {
      refuse("signature", "alg_not_allowed");
    }
    if (jws.header.crit !== undefined) refuse("malformed", "crit_not_understood");
    const kid = jws.header.kid;
    if (typeof kid !== "string" || kid.length === 0 || kid.length > 256) {
      refuse("malformed", "kid_missing");
    }
    let cache = await currentJwks();
    let key = await keyFor(cache, kid, alg as IdTokenAlgorithm);
    if (!key && clock.now() - cache.fetchedAt >= cooldownMs) {
      // A key the cached set lacks: the issuer may have rotated. Refetch once, then decide.
      cache = await fetchJwks();
      key = await keyFor(cache, kid, alg as IdTokenAlgorithm);
    }
    if (!key) refuse("signature", "unknown_kid");
    if (!(await verifyJwsSignature(jws, key, alg as IdTokenAlgorithm))) {
      refuse("signature", "bad_signature");
    }
  }

  return {
    async verify(token: string): Promise<StaffIdentity> {
      const jws = parseJws(token);
      if (!jws) return refuse("malformed", "not_a_jws");
      await verifySignature(jws);
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
