/**
 * Sealed values for the browser (the OpenID transaction cookie, §4.1): AES-256-GCM over JSON,
 * with a key per purpose derived by HKDF-SHA256 from each configured secret, so no server storage
 * is needed and any replica or isolate with the secrets can open what another sealed. The key id
 * travels with the value, so rotating secrets (first seals, all open) keeps in-flight values
 * working. Associated data binds a value to where it may be opened (a provider's callback).
 */
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from "../../encoding.ts";

export interface SealingSecret {
  id: string;
  secret: string;
}

export interface Sealer {
  seal(value: unknown, associatedData: string): Promise<string>;
  /** Null for anything not sealed by one of the secrets for this purpose and associated data. */
  open(sealed: string, associatedData: string): Promise<unknown>;
}

const VERSION = "s1";
const IV_BYTES = 12;
const MAX_SEALED_LENGTH = 4096;

export function createSealer(secrets: readonly SealingSecret[], purpose: string): Sealer {
  const first = secrets[0];
  if (!first) throw new TypeError("At least one sealing secret is required");
  const keys = new Map<string, Promise<CryptoKey>>();
  const keyFor = (entry: SealingSecret): Promise<CryptoKey> => {
    let key = keys.get(entry.id);
    if (!key) {
      key = (async () => {
        const material = await crypto.subtle.importKey(
          "raw",
          utf8Encode(entry.secret),
          "HKDF",
          false,
          ["deriveKey"],
        );
        return crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: utf8Encode("webflix-seal"),
            info: utf8Encode(`webflix:${purpose}`),
          },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
      })();
      keys.set(entry.id, key);
    }
    return key;
  };

  return {
    async seal(value, associatedData) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: utf8Encode(associatedData) },
        await keyFor(first),
        utf8Encode(JSON.stringify(value)),
      );
      return [
        VERSION,
        base64UrlEncode(utf8Encode(first.id)),
        base64UrlEncode(iv),
        base64UrlEncode(new Uint8Array(ciphertext)),
      ].join(".");
    },

    async open(sealed, associatedData) {
      if (typeof sealed !== "string" || sealed.length > MAX_SEALED_LENGTH) return null;
      const parts = sealed.split(".");
      if (parts.length !== 4 || parts[0] !== VERSION) return null;
      try {
        const id = utf8Decode(base64UrlDecode(parts[1] ?? ""));
        const entry = secrets.find((candidate) => candidate.id === id);
        if (!entry) return null;
        const iv = base64UrlDecode(parts[2] ?? "");
        if (iv.length !== IV_BYTES) return null;
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: utf8Encode(associatedData) },
          await keyFor(entry),
          base64UrlDecode(parts[3] ?? ""),
        );
        return JSON.parse(utf8Decode(new Uint8Array(plaintext))) as unknown;
      } catch {
        return null;
      }
    },
  };
}
