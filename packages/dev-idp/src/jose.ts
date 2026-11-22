/**
 * The small part of JOSE the issuer needs, on Web Crypto: compact JWS (RS256, ES256), JWK
 * handling and RFC 7638 thumbprints. Deliberately hand-written rather than a library: the fault
 * catalogue must produce tokens a JOSE library refuses to make (`alg: none`, HMAC keyed with a
 * public key, a header carrying its own key).
 */
import {
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  base64UrlEncodeText,
  isRecord,
  sha256,
  utf8Decode,
  utf8Encode,
} from "./encoding.ts";

export const SIGNING_ALGORITHMS = ["RS256", "ES256"] as const;
export type SigningAlgorithm = (typeof SIGNING_ALGORITHMS)[number];

export function isSigningAlgorithm(value: unknown): value is SigningAlgorithm {
  return value === "RS256" || value === "ES256";
}

/**
 * A JSON Web Key (RFC 7517). Declared here because Node's type environment has no global
 * `JsonWebKey`; structurally compatible with the Web Crypto one.
 */
export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  d?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
}

/** A private signing key as the issuer stores it: RSA 2048+ for RS256, P-256 for ES256. */
export interface PrivateSigningJwk extends Jwk {
  kid: string;
  alg: SigningAlgorithm;
  d: string;
}

type JsonObject = Record<string, unknown>;

const IMPORT_PARAMS = {
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  ES256: { name: "ECDSA", namedCurve: "P-256" },
} as const;

const SIGN_PARAMS = {
  RS256: { name: "RSASSA-PKCS1-v1_5" },
  ES256: { name: "ECDSA", hash: "SHA-256" },
} as const;

function expectedKty(alg: SigningAlgorithm): string {
  return alg === "RS256" ? "RSA" : "EC";
}

/** Only the members a public key of this type has: never `d` or the RSA CRT values. */
export function toPublicJwk(jwk: Jwk): Jwk {
  const common = { kid: jwk.kid, alg: jwk.alg, use: "sig" };
  if (jwk.kty === "RSA") return { kty: "RSA", ...common, n: jwk.n, e: jwk.e };
  return { kty: "EC", ...common, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/** Throws when the JWK is not a usable private key for its `alg`. */
export function assertPrivateSigningJwk(value: unknown): asserts value is PrivateSigningJwk {
  if (!isRecord(value)) throw new TypeError("A signing key must be a JWK object");
  const { kid, alg, kty, d } = value;
  if (typeof kid !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(kid)) {
    throw new TypeError("A signing key needs a kid of 1-64 characters [A-Za-z0-9._-]");
  }
  if (!isSigningAlgorithm(alg))
    throw new TypeError(`Signing key ${kid}: alg must be RS256 or ES256`);
  if (kty !== expectedKty(alg))
    throw new TypeError(`Signing key ${kid}: kty does not match ${alg}`);
  if (typeof d !== "string") throw new TypeError(`Signing key ${kid}: private member d missing`);
  if (alg === "ES256" && value.crv !== "P-256") {
    throw new TypeError(`Signing key ${kid}: ES256 needs crv P-256`);
  }
  if (alg === "RS256" && (typeof value.n !== "string" || base64UrlDecode(value.n).length < 256)) {
    throw new TypeError(`Signing key ${kid}: RS256 needs a modulus of at least 2048 bits`);
  }
}

/** The members Web Crypto's JWK import reads; `kid` and `use` are ours, not its. */
function importableJwk(jwk: Jwk, privateKey: boolean): Jwk {
  const { kid: _kid, use: _use, ...rest } = privateKey ? jwk : toPublicJwk(jwk);
  const out: Jwk = { kty: rest.kty };
  for (const [name, value] of Object.entries(rest)) {
    if (value !== undefined) (out as unknown as Record<string, string>)[name] = value;
  }
  return out;
}

export async function importSigningKey(jwk: PrivateSigningJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", importableJwk(jwk, true), IMPORT_PARAMS[jwk.alg], false, [
    "sign",
  ]);
}

export async function importVerificationKey(jwk: Jwk, alg: SigningAlgorithm): Promise<CryptoKey> {
  if (jwk.kty !== expectedKty(alg)) throw new TypeError(`Key type ${jwk.kty} cannot verify ${alg}`);
  return crypto.subtle.importKey(
    "jwk",
    { ...importableJwk(jwk, false), alg },
    IMPORT_PARAMS[alg],
    true,
    ["verify"],
  );
}

function signingInput(header: JsonObject, payload: JsonObject): string {
  return `${base64UrlEncodeText(JSON.stringify(header))}.${base64UrlEncodeText(JSON.stringify(payload))}`;
}

export async function signJws(
  header: JsonObject & { alg: SigningAlgorithm },
  payload: JsonObject,
  key: CryptoKey,
): Promise<string> {
  const input = signingInput(header, payload);
  const signature = await crypto.subtle.sign(SIGN_PARAMS[header.alg], key, utf8Encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** An Unsecured JWS (RFC 7515 §A.5): `alg: none` and an empty signature. Faults only. */
export function unsecuredJws(header: JsonObject, payload: JsonObject): string {
  return `${signingInput({ ...header, alg: "none" }, payload)}.`;
}

/** HS256 over the given secret bytes. Faults only: the issuer never signs with HMAC. */
export async function hmacJws(
  header: JsonObject,
  payload: JsonObject,
  secret: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const input = signingInput({ ...header, alg: "HS256" }, payload);
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, utf8Encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export interface DecodedJws {
  header: JsonObject;
  payload: JsonObject;
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

const MAX_JWS_LENGTH = 16_384;

/** Splits and parses a compact JWS without verifying it. Null when it is not well formed. */
export function decodeJws(token: string): DecodedJws | null {
  if (token.length > MAX_JWS_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader = "", encodedPayload = "", encodedSignature = ""] = parts;
  try {
    const header: unknown = JSON.parse(utf8Decode(base64UrlDecode(encodedHeader)));
    const payload: unknown = JSON.parse(utf8Decode(base64UrlDecode(encodedPayload)));
    if (!isRecord(header) || !isRecord(payload)) return null;
    return {
      header,
      payload,
      signingInput: `${encodedHeader}.${encodedPayload}`,
      signature: base64UrlDecode(encodedSignature),
    };
  } catch {
    return null;
  }
}

export async function verifyJws(
  decoded: DecodedJws,
  key: CryptoKey,
  alg: SigningAlgorithm,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      SIGN_PARAMS[alg],
      key,
      decoded.signature,
      utf8Encode(decoded.signingInput),
    );
  } catch {
    // A signature of the wrong length: some runtimes throw instead of answering false.
    return false;
  }
}

/** RFC 7638 JWK thumbprint (SHA-256), used as the `kid` of generated keys. */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
  const members =
    jwk.kty === "RSA"
      ? { e: jwk.e, kty: jwk.kty, n: jwk.n }
      : { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return base64UrlEncode(await sha256(JSON.stringify(members)));
}

/**
 * Web Crypto's type declarations differ between runtimes: the DOM/WebWorker library narrows
 * `generateKey` and `exportKey` by their arguments, `@cloudflare/workers-types` returns the
 * unions (`CryptoKey | CryptoKeyPair`, `ArrayBuffer | JsonWebKey`). These checks narrow at run
 * time, so the same source typechecks (and behaves) under both.
 */
interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

function asKeyPair(generated: unknown): KeyPair {
  if (
    typeof generated === "object" &&
    generated !== null &&
    "privateKey" in generated &&
    "publicKey" in generated
  ) {
    return generated as KeyPair;
  }
  throw new TypeError("Expected an asymmetric key pair");
}

function asArrayBuffer(exported: unknown): ArrayBuffer {
  if (exported instanceof ArrayBuffer) return exported;
  throw new TypeError("Expected the key exported as bytes");
}

function asJwk(exported: unknown): Jwk {
  if (isRecord(exported) && typeof exported.kty === "string") return exported as unknown as Jwk;
  throw new TypeError("Expected the key exported as a JWK");
}

/** A fresh private key for `alg`, with its thumbprint as `kid`. */
export async function generateSigningJwk(alg: SigningAlgorithm): Promise<PrivateSigningJwk> {
  const usages: Array<"sign" | "verify"> = ["sign", "verify"];
  const pair = asKeyPair(
    alg === "RS256"
      ? await crypto.subtle.generateKey(
          {
            name: "RSASSA-PKCS1-v1_5",
            hash: "SHA-256",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
          },
          true,
          usages,
        )
      : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, usages),
  );
  const exported = asJwk(await crypto.subtle.exportKey("jwk", pair.privateKey));
  const material: Jwk =
    alg === "RS256"
      ? {
          kty: "RSA",
          n: exported.n,
          e: exported.e,
          d: exported.d,
          p: exported.p,
          q: exported.q,
          dp: exported.dp,
          dq: exported.dq,
          qi: exported.qi,
        }
      : { kty: "EC", crv: "P-256", x: exported.x, y: exported.y, d: exported.d };
  const jwk = { ...material, kid: await jwkThumbprint(material), alg };
  assertPrivateSigningJwk(jwk);
  return jwk;
}

/** The public key as PEM-encoded SubjectPublicKeyInfo, with a trailing newline. */
export async function publicKeyPem(jwk: Jwk, alg: SigningAlgorithm): Promise<string> {
  const key = await importVerificationKey(jwk, alg);
  const der = new Uint8Array(asArrayBuffer(await crypto.subtle.exportKey("spki", key)));
  const lines = base64Encode(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

/**
 * `at_hash` (OpenID Connect Core §3.1.3.6): the left half of the hash of the ASCII token, with
 * the hash of the ID token's `alg`. SHA-256 for both RS256 and ES256.
 */
export async function leftHalfHash(value: string): Promise<string> {
  const digest = await sha256(value);
  return base64UrlEncode(digest.subarray(0, digest.length / 2));
}
