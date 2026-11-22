/**
 * The part of JOSE a relying party needs, on Web Crypto only: compact JWS parsing, signature
 * verification with keys from the issuer's JWKS (RS256, ES256), `at_hash`, and signing Apple's
 * ES256 client secret. Hand-written on purpose: the algorithm is always chosen from the issuer's
 * configuration and the key's type, never from the token header, and keys a token carries
 * (`jwk`, `jku`, `x5u`, `x5c`) are never looked at.
 */
import {
  base64Decode,
  base64UrlDecode,
  base64UrlEncode,
  utf8Decode,
  utf8Encode,
} from "../../encoding.ts";

export const ID_TOKEN_ALGORITHMS = ["RS256", "ES256"] as const;
export type IdTokenAlgorithm = (typeof ID_TOKEN_ALGORITHMS)[number];

type Json = Record<string, unknown>;

export interface PublicJwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
}

export interface ParsedJws {
  header: Json;
  payload: Json;
  signingInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

/** ID tokens of the real issuers are 1-2 KB; anything this large is refused unparsed. */
const MAX_JWS_LENGTH = 16 * 1024;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Splits and parses a compact JWS without trusting it. Null when it is not well formed. */
export function parseJws(token: string): ParsedJws | null {
  if (typeof token !== "string" || token.length > MAX_JWS_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header = "", payload = "", signature = ""] = parts;
  try {
    const parsedHeader: unknown = JSON.parse(utf8Decode(base64UrlDecode(header)));
    const parsedPayload: unknown = JSON.parse(utf8Decode(base64UrlDecode(payload)));
    if (!isRecord(parsedHeader) || !isRecord(parsedPayload)) return null;
    return {
      header: parsedHeader,
      payload: parsedPayload,
      signingInput: utf8Encode(`${header}.${payload}`),
      signature: base64UrlDecode(signature),
    };
  } catch {
    return null;
  }
}

const VERIFY_PARAMS = {
  RS256: {
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
    kty: "RSA",
  },
  ES256: {
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
    kty: "EC",
  },
} as const;

/**
 * The verification key for `alg` from a published JWK, or null when the JWK cannot verify that
 * algorithm (another key type or curve, an encryption key, a declared `alg` that differs).
 */
export async function importVerificationKey(
  jwk: PublicJwk,
  alg: IdTokenAlgorithm,
): Promise<CryptoKey | null> {
  const params = VERIFY_PARAMS[alg];
  if (jwk.kty !== params.kty) return null;
  if (jwk.use !== undefined && jwk.use !== "sig") return null;
  if (jwk.alg !== undefined && jwk.alg !== alg) return null;
  // The public members only, typed as a JWK in every runtime's declarations.
  let material: { kty: string; n?: string; e?: string; crv?: string; x?: string; y?: string };
  if (alg === "RS256") {
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") return null;
    // RSA below 2048 bits is refused (RFC 7518 §3.3).
    if (base64UrlDecode(jwk.n).length < 256) return null;
    material = { kty: "RSA", n: jwk.n, e: jwk.e };
  } else {
    if (jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") return null;
    material = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  }
  try {
    return await crypto.subtle.importKey("jwk", material, params.import, false, ["verify"]);
  } catch {
    return null;
  }
}

export async function verifyJwsSignature(
  jws: ParsedJws,
  key: CryptoKey,
  alg: IdTokenAlgorithm,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      VERIFY_PARAMS[alg].verify,
      key,
      jws.signature,
      jws.signingInput,
    );
  } catch {
    // A signature of the wrong length: some runtimes throw instead of answering false.
    return false;
  }
}

/**
 * `at_hash` (OpenID Connect Core §3.1.3.6): the left half of the SHA-256 of the access token,
 * base64url. SHA-256 for both RS256 and ES256.
 */
export async function accessTokenHash(accessToken: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8Encode(accessToken)));
  return base64UrlEncode(digest.subarray(0, digest.length / 2));
}

// --- Signing Apple's client secret -----------------------------------------------------------

/** A P-256 private key: PKCS#8 PEM (the `.p8` file Apple hands out) or a JWK with `d`. */
export type Es256PrivateKey = string | (PublicJwk & { d: string });

export async function importEs256SigningKey(key: Es256PrivateKey): Promise<CryptoKey> {
  const params = { name: "ECDSA", namedCurve: "P-256" } as const;
  if (typeof key === "string") {
    const body = key
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s+/g, "");
    return crypto.subtle.importKey("pkcs8", base64Decode(body), params, false, ["sign"]);
  }
  const { kty, crv, x, y, d } = key;
  return crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, params, false, ["sign"]);
}

/** A compact JWS signed with ES256 (the signature is raw r||s, as JWS requires). */
export async function signEs256(header: Json, payload: Json, key: CryptoKey): Promise<string> {
  const encode = (value: Json) => base64UrlEncode(utf8Encode(JSON.stringify(value)));
  const input = `${encode({ ...header, alg: "ES256" })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8Encode(input),
  );
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}
