/** Byte/string helpers on Web-standard APIs only (btoa/atob, TextEncoder, WebCrypto). */

const encoder = new TextEncoder();
// ignoreBOM spelled out: Workers types require every option.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function utf8Encode(value: string): Uint8Array<ArrayBuffer> {
  // encode() always returns a fresh ArrayBuffer-backed array; some runtime typings widen it.
  return encoder.encode(value) as Uint8Array<ArrayBuffer>;
}

/** Throws `TypeError` on invalid UTF-8. */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
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

/** Standard base64 without padding (the PHC string format's "B64"). */
export function base64Encode(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes)).replace(/=+$/, "");
}

/** Accepts standard base64 with or without padding. Throws `TypeError` on invalid input. */
export function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new TypeError("Invalid base64");
  const unpadded = value.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) throw new TypeError("Invalid base64 length");
  return binaryToBytes(atob(unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=")));
}

/** RFC 4648 §5 base64url without padding: safe in URL paths, cookies and headers. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replaceAll("+", "-").replaceAll("/", "_");
}

/** Throws `TypeError` on invalid input. */
export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new TypeError("Invalid base64url");
  return base64Decode(value.replaceAll("-", "+").replaceAll("_", "/"));
}

export function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Compare two byte arrays without an early exit on the first difference. Length is not
 * secret in our uses (fixed-size digests), so a length mismatch returns immediately.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return hexEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}
