import type { JsonValue } from "@webflix/contracts";
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from "../encoding.ts";
import { type Clock, systemClock } from "./clock.ts";

/** A secret for HMAC signing. Rotate by adding a new key first; old keys keep verifying. */
export interface SigningKey {
  /** Short identifier embedded in tokens (`[A-Za-z0-9_-]{1,16}`). */
  id: string;
  /** At least 32 characters of high-entropy text. */
  secret: string;
}

export interface TokenClaims {
  /** What the token is for; verification rejects tokens minted for another purpose. */
  purpose: string;
  /** Expiry, seconds since the Unix epoch. */
  exp: number;
  [claim: string]: JsonValue;
}

export type TokenRejection =
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "wrong_purpose"
  | "expired";

export type TokenVerification =
  | { valid: true; claims: TokenClaims; keyId: string }
  | { valid: false; reason: TokenRejection };

/**
 * Port: stateless signed tokens (media path tokens, blueprint §2.4). Output is URL-path-safe
 * (`[A-Za-z0-9_.-]`). Implementations must check the signature before trusting any claim.
 */
export interface TokenSigner {
  sign(claims: TokenClaims): Promise<string>;
  verify(token: string, expectedPurpose: string): Promise<TokenVerification>;
}

export const MIN_SIGNING_SECRET_LENGTH = 32;
const MAX_TOKEN_LENGTH = 4096;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * HMAC-SHA256 tokens on WebCrypto: `base64url(json claims + kid) "." base64url(mac)`.
 * Signs with the first key; verifies with whichever key the token names.
 */
export function createHmacTokenSigner(options: {
  keys: readonly SigningKey[];
  clock?: Clock;
}): TokenSigner {
  const [signingKey] = options.keys;
  if (!signingKey) throw new Error("createHmacTokenSigner needs at least one key");
  for (const key of options.keys) {
    if (!KEY_ID_PATTERN.test(key.id)) throw new Error(`Invalid signing key id "${key.id}"`);
    if (key.secret.length < MIN_SIGNING_SECRET_LENGTH) {
      throw new Error(`Signing key "${key.id}" is shorter than ${MIN_SIGNING_SECRET_LENGTH} chars`);
    }
  }
  const clock = options.clock ?? systemClock;
  // Imported keys, once imported: a pending import is never shared between requests (on
  // Workers a promise from one request must not be awaited by another).
  const cryptoKeys = new Map<string, CryptoKey>();
  const cryptoKey = async (key: SigningKey): Promise<CryptoKey> => {
    const cached = cryptoKeys.get(key.id);
    if (cached) return cached;
    const imported = await crypto.subtle.importKey(
      "raw",
      utf8Encode(key.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    cryptoKeys.set(key.id, imported);
    return imported;
  };

  return {
    async sign(claims) {
      const payload = base64UrlEncode(
        utf8Encode(JSON.stringify({ ...claims, kid: signingKey.id })),
      );
      const mac = await crypto.subtle.sign(
        "HMAC",
        await cryptoKey(signingKey),
        utf8Encode(payload),
      );
      return `${payload}.${base64UrlEncode(new Uint8Array(mac))}`;
    },

    async verify(token, expectedPurpose) {
      if (token.length > MAX_TOKEN_LENGTH) return { valid: false, reason: "malformed" };
      const [payload, signature, extra] = token.split(".");
      if (!payload || !signature || extra !== undefined)
        return { valid: false, reason: "malformed" };

      let claims: unknown;
      let mac: Uint8Array<ArrayBuffer>;
      try {
        claims = JSON.parse(utf8Decode(base64UrlDecode(payload)));
        mac = base64UrlDecode(signature);
      } catch {
        return { valid: false, reason: "malformed" };
      }
      if (!isRecord(claims) || typeof claims.kid !== "string") {
        return { valid: false, reason: "malformed" };
      }
      const key = options.keys.find((candidate) => candidate.id === claims.kid);
      if (!key) return { valid: false, reason: "unknown_key" };

      const authentic = await crypto.subtle.verify(
        "HMAC",
        await cryptoKey(key),
        mac,
        utf8Encode(payload),
      );
      if (!authentic) return { valid: false, reason: "bad_signature" };

      const { kid: _kid, ...rest } = claims;
      if (typeof rest.purpose !== "string" || typeof rest.exp !== "number") {
        return { valid: false, reason: "malformed" };
      }
      if (rest.purpose !== expectedPurpose) return { valid: false, reason: "wrong_purpose" };
      if (rest.exp * 1000 <= clock.now()) return { valid: false, reason: "expired" };
      return { valid: true, claims: rest as TokenClaims, keyId: key.id };
    },
  };
}

// --- Media path tokens (blueprint §2.4) -------------------------------------------------------

export const MEDIA_TOKEN_PURPOSE = "media";

export interface MediaTokenClaims {
  assetId: string;
  playbackSessionId: string;
  /** Seconds since the Unix epoch. */
  exp: number;
  /**
   * The plan's rendition cap when the token was issued (claim `h`): renditions taller than it
   * are refused. Null for tokens issued before the claim existed (no cap enforced on them).
   */
  maxVideoHeight: number | null;
}

export type MediaTokenVerification =
  | { valid: true; claims: MediaTokenClaims }
  | { valid: false; reason: TokenRejection | "wrong_asset" };

export interface MediaTokens {
  issue(input: {
    assetId: string;
    playbackSessionId: string;
    ttlSec: number;
    maxVideoHeight: number;
  }): Promise<{ token: string; expiresAt: number }>;
  /** Verifies the signature, expiry and that the token was minted for `assetId`. */
  verify(token: string, assetId: string): Promise<MediaTokenVerification>;
}

/**
 * Tokens embedded in `/media/{token}/vod/{assetId}/...` paths. Verification is stateless; the
 * asset binding stops one token from unlocking other titles.
 */
export function createMediaTokens(signer: TokenSigner, clock: Clock = systemClock): MediaTokens {
  return {
    async issue({ assetId, playbackSessionId, ttlSec, maxVideoHeight }) {
      const exp = Math.floor(clock.now() / 1000) + ttlSec;
      const token = await signer.sign({
        purpose: MEDIA_TOKEN_PURPOSE,
        exp,
        a: assetId,
        s: playbackSessionId,
        h: maxVideoHeight,
      });
      return { token, expiresAt: exp * 1000 };
    },

    async verify(token, assetId) {
      const result = await signer.verify(token, MEDIA_TOKEN_PURPOSE);
      if (!result.valid) return result;
      const { a, s, exp, h } = result.claims;
      if (typeof a !== "string" || typeof s !== "string") {
        return { valid: false, reason: "malformed" };
      }
      if (h !== undefined && (typeof h !== "number" || !Number.isInteger(h) || h < 1)) {
        return { valid: false, reason: "malformed" };
      }
      if (a !== assetId) return { valid: false, reason: "wrong_asset" };
      return {
        valid: true,
        claims: { assetId: a, playbackSessionId: s, exp, maxVideoHeight: h ?? null },
      };
    },
  };
}
