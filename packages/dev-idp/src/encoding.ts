/** Byte and string helpers on Web-standard APIs only (btoa/atob, TextEncoder, Web Crypto). */

const encoder = new TextEncoder();
// ignoreBOM spelled out: Workers types require every option.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function utf8Encode(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value) as Uint8Array<ArrayBuffer>;
}

/** Throws `TypeError` on invalid UTF-8. */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";
  // Chunked to stay below the argument-count limit of String.fromCharCode.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return binary;
}

function binaryToBytes(binary: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function base64Encode(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes));
}

/** RFC 4648 §5 base64url without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Strict base64url without padding. Throws `TypeError` on anything else. */
export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(value) || value.length % 4 === 1) throw new TypeError("Invalid base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return binaryToBytes(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
}

export function base64UrlEncodeText(value: string): string {
  return base64UrlEncode(utf8Encode(value));
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** 128 bits or more of randomness, base64url. */
export function randomToken(bytes = 16): string {
  return base64UrlEncode(randomBytes(bytes));
}

export async function sha256(
  data: Uint8Array<ArrayBuffer> | string,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof data === "string" ? utf8Encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * Compares two strings without an early exit on the first difference. Both sides are hashed
 * first, so the time taken does not depend on where they differ or on their lengths.
 */
export async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Seconds since the Unix epoch, as JWT `NumericDate` values are. */
export function epochSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** A short, stable, non-cryptographic tag (FNV-1a) for names such as cookie suffixes. */
export function shortTag(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}
