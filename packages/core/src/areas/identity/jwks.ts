/**
 * An issuer's published signing keys (JWKS), and the one way Webflix verifies a JWS against
 * them: the member relying party (`createOidcIdentityProvider`) and the staff API's resource
 * server (`createOidcStaffVerifier`) both use it, so the rules live in one place, proven against
 * the development issuer's fault catalogue.
 *
 * - The algorithm comes from configuration (and the key's type), never from the token header:
 *   `none`, HS256 keyed with a public key, or any other algorithm is refused before a key is
 *   looked at. A header with `crit` is refused (no extension is understood).
 * - Keys come only from the JWKS, by `kid`; keys a token carries (`jwk`, `jku`, `x5u`, `x5c`)
 *   are never read.
 * - The set is cached (`cacheTtlSec`); concurrent fetches share one request. An unknown `kid`
 *   refetches the set once, only if the last fetch is at least `refetchCooldownSec` old (a key
 *   rotated in is accepted; a bogus `kid` cannot make every request call the issuer), and is
 *   refused if still unknown.
 * - A failed refresh keeps the keys already trusted; with none, verification fails as
 *   `unavailable`, never as a verified token.
 * - Every call to the issuer has a deadline (an in-process issuer ignores abort signals, so it is
 *   raced) and a response size cap.
 */
import { utf8Decode } from "../../encoding.ts";
import { type Clock, systemClock } from "../../ports/clock.ts";
import {
  type IdTokenAlgorithm,
  importVerificationKey,
  type ParsedJws,
  type PublicJwk,
  verifyJwsSignature,
} from "./jose.ts";

export const JWKS_FAILURES = [
  "alg_not_allowed",
  "crit_not_understood",
  "kid_missing",
  "unknown_kid",
  "bad_signature",
  "unavailable",
] as const;
export type JwksFailure = (typeof JWKS_FAILURES)[number];

/** A refused verification. `message` is a detail for logs (`jwks_status_503`, `issuer_timeout`...). */
export class JwksError extends Error {
  override readonly name = "JwksError";
  readonly reason: JwksFailure;

  constructor(reason: JwksFailure, detail: string = reason) {
    super(detail);
    this.reason = reason;
  }
}

export type JwksFetch = (request: Request) => Promise<Response>;

export interface JwksKeySetOptions {
  /**
   * Where the set is published: a URL, or a function resolving it (an issuer's discovery
   * document). What the function throws is passed through unchanged.
   */
  jwksUri: string | (() => Promise<string>);
  /** Default RS256 only. */
  algorithms?: readonly IdTokenAlgorithm[];
  /** Default: global `fetch`. The development issuer: its handler, in process. */
  fetch?: JwksFetch;
  clock?: Clock;
  /** Per call to the issuer. Default 5000 ms. */
  timeoutMs?: number;
  /** How long a fetched set is trusted before it is fetched again. Default 1 h. */
  cacheTtlSec?: number;
  /** An unknown `kid` refetches only if the last fetch is at least this old. Default 10 s. */
  refetchCooldownSec?: number;
}

export interface JwksKeySet {
  /** Verifies a parsed JWS's signature against the issuer's keys; throws `JwksError`. */
  verify(jws: ParsedJws): Promise<void>;
}

interface CachedJwks {
  keys: PublicJwk[];
  fetchedAt: number;
  imported: Map<string, CryptoKey | null>;
}

const MAX_RESPONSE_BYTES = 256 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A JSON document from an issuer, with a deadline and a size cap; `JwksError("unavailable")`
 * otherwise. Shared by the key set and the issuers' other documents (discovery).
 */
export async function fetchIssuerJson(
  fetcher: JwksFetch,
  url: string,
  what: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JwksError("unavailable", "issuer_timeout"));
    }, timeoutMs);
  });
  let response: Response;
  try {
    response = await Promise.race([
      fetcher(
        new Request(url, {
          ...init,
          headers: { Accept: "application/json", ...(init.headers as Record<string, string>) },
          signal: controller.signal,
        }),
      ),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof JwksError) throw error;
    throw new JwksError("unavailable", "issuer_unreachable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new JwksError("unavailable", `${what}_too_large`);
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
        throw new JwksError("unavailable", `${what}_too_large`);
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
    return { status: response.status, ok: response.ok, body: JSON.parse(utf8Decode(bytes)) };
  } catch {
    // An error status speaks for itself (callers name it); only a success must be JSON.
    if (!response.ok) return { status: response.status, ok: false, body: null };
    throw new JwksError("unavailable", `${what}_not_json`);
  }
}

export function createJwksKeySet(options: JwksKeySetOptions): JwksKeySet {
  const clock = options.clock ?? systemClock;
  const fetcher: JwksFetch = options.fetch ?? ((request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? 5000;
  const cacheTtlMs = (options.cacheTtlSec ?? 3600) * 1000;
  const cooldownMs = (options.refetchCooldownSec ?? 10) * 1000;
  const algorithms = new Set<IdTokenAlgorithm>(options.algorithms ?? ["RS256"]);
  if (algorithms.size === 0) throw new TypeError("At least one signing algorithm is needed");
  const resolveUri =
    typeof options.jwksUri === "string"
      ? (() => {
          const uri = options.jwksUri;
          return async () => uri;
        })()
      : options.jwksUri;

  // Only settled values are shared between verifications: the last set fetched and when the last
  // fetch started. Never an in-flight fetch: on Workers one request may not await a promise
  // another request settles (docs/CLOUDFLARE.md §2). So on a cold cache concurrent verifications
  // each fetch; on a stale one the first refreshes while the others keep the trusted set; and an
  // unknown key id refetches at most once per cooldown, whoever asks.
  let jwks: CachedJwks | null = null;
  let fetchStartedAt = Number.NEGATIVE_INFINITY;

  async function fetchJwks(): Promise<CachedJwks> {
    fetchStartedAt = clock.now();
    const uri = await resolveUri();
    const { ok, status, body } = await fetchIssuerJson(fetcher, uri, "jwks", timeoutMs);
    if (!ok) throw new JwksError("unavailable", `jwks_status_${status}`);
    if (!isRecord(body) || !Array.isArray(body.keys)) {
      throw new JwksError("unavailable", "jwks_invalid");
    }
    const keys = body.keys.filter(
      (key): key is PublicJwk => isRecord(key) && typeof key.kty === "string",
    );
    const fetched: CachedJwks = { keys, fetchedAt: clock.now(), imported: new Map() };
    jwks = fetched;
    return fetched;
  }

  /** The current set: cached, refreshed when stale; a failed refresh keeps the trusted keys. */
  async function currentJwks(): Promise<CachedJwks> {
    const now = clock.now();
    if (jwks && now - jwks.fetchedAt < cacheTtlMs) return jwks;
    // Stale, and a refresh started within the cooldown (running, or failed): keep the trusted set.
    if (jwks && now - fetchStartedAt < cooldownMs) return jwks;
    try {
      return await fetchJwks();
    } catch (error) {
      // An issuer outage must not lock out keys already trusted; with none, fail.
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

  return {
    async verify(jws) {
      const alg = jws.header.alg;
      if (typeof alg !== "string" || !algorithms.has(alg as IdTokenAlgorithm)) {
        throw new JwksError("alg_not_allowed");
      }
      if (jws.header.crit !== undefined) throw new JwksError("crit_not_understood");
      const kid = jws.header.kid;
      if (typeof kid !== "string" || kid.length === 0 || kid.length > 256) {
        throw new JwksError("kid_missing");
      }
      let cache = await currentJwks();
      let key = await keyFor(cache, kid, alg as IdTokenAlgorithm);
      if (!key && clock.now() - Math.max(cache.fetchedAt, fetchStartedAt) >= cooldownMs) {
        // A key the cached set lacks: the issuer may have rotated. Refetch once, then decide.
        cache = await fetchJwks();
        key = await keyFor(cache, kid, alg as IdTokenAlgorithm);
      }
      if (!key) throw new JwksError("unknown_kid");
      if (!(await verifyJwsSignature(jws, key, alg as IdTokenAlgorithm))) {
        throw new JwksError("bad_signature");
      }
    },
  };
}
