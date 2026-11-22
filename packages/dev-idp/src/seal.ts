/**
 * Sealed (encrypted and authenticated) self-contained artefacts: authorisation codes, the
 * sign-in page's transaction, issuer sessions, refresh tokens and opaque access tokens. Nothing
 * is looked up server-side to read one, so any instance holding the secret can, which is what a
 * Workers deployment (no memory shared between isolates) needs.
 *
 * AES-256-GCM with a key per purpose and issuer derived by HKDF: a sealed session cannot be
 * replayed as a code, nor a code of one issuer at another issuer sharing the secret.
 */
import {
  base64UrlDecode,
  base64UrlEncode,
  isRecord,
  randomBytes,
  utf8Decode,
  utf8Encode,
} from "./encoding.ts";
import type { Clock } from "./store.ts";

export type SealPurpose = "code" | "txn" | "logout" | "session" | "refresh" | "access";

const VERSION = 1;
const IV_BYTES = 12;
// The largest sign-in transaction (state, nonce, login_hint and redirect URI at their limits)
// seals to about 9 KB.
const MAX_SEALED_LENGTH = 12_288;

export interface SealedPayload {
  /** Expiry, seconds since the Unix epoch. Unsealing refuses anything at or past it. */
  exp: number;
  [member: string]: unknown;
}

export class Sealer {
  private readonly issuer: string;
  private readonly clock: Clock;
  private readonly secret: Uint8Array<ArrayBuffer>;
  // Derived keys, cached once derived: a pending derivation is never shared between requests
  // (on Workers a promise created by one request must not be awaited by another).
  private readonly keys = new Map<SealPurpose, CryptoKey>();

  constructor(options: { secret: Uint8Array<ArrayBuffer>; issuer: string; clock: Clock }) {
    if (options.secret.length < 32)
      throw new RangeError("The sealing secret needs 32 bytes or more");
    this.secret = options.secret;
    this.issuer = options.issuer;
    this.clock = options.clock;
  }

  async seal(purpose: SealPurpose, payload: SealedPayload): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8Encode(purpose) },
      await this.key(purpose),
      utf8Encode(JSON.stringify(payload)),
    );
    const sealed = new Uint8Array(1 + IV_BYTES + ciphertext.byteLength);
    sealed[0] = VERSION;
    sealed.set(iv, 1);
    sealed.set(new Uint8Array(ciphertext), 1 + IV_BYTES);
    return base64UrlEncode(sealed);
  }

  /** The payload, or null when the value is malformed, forged, for another purpose or expired. */
  async unseal(purpose: SealPurpose, value: string): Promise<SealedPayload | null> {
    if (value.length === 0 || value.length > MAX_SEALED_LENGTH) return null;
    try {
      const sealed = base64UrlDecode(value);
      if (sealed.length < 1 + IV_BYTES + 16 || sealed[0] !== VERSION) return null;
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: sealed.slice(1, 1 + IV_BYTES),
          additionalData: utf8Encode(purpose),
        },
        await this.key(purpose),
        sealed.slice(1 + IV_BYTES),
      );
      const payload: unknown = JSON.parse(utf8Decode(new Uint8Array(plaintext)));
      if (!isRecord(payload) || typeof payload.exp !== "number") return null;
      if (payload.exp * 1000 <= this.clock.now()) return null;
      return payload as SealedPayload;
    } catch {
      return null;
    }
  }

  private async key(purpose: SealPurpose): Promise<CryptoKey> {
    const cached = this.keys.get(purpose);
    if (cached) return cached;
    const base = await crypto.subtle.importKey("raw", this.secret, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: utf8Encode("webflix-dev-idp/seal/v1"),
        info: utf8Encode(`${purpose}\n${this.issuer}`),
      },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    this.keys.set(purpose, key);
    return key;
  }
}
