import {
  hexEncode,
  type ProviderEvent,
  timingSafeEqual,
  utf8Decode,
  utf8Encode,
  WEBHOOK_TOLERANCE_SEC,
  WebhookSignatureError,
} from "@webflix/core";
import { toEvent } from "./mapping.ts";

/**
 * Stripe's webhook signature (`Stripe-Signature: t=…,v1=…[,v0=…]`): HMAC-SHA256 with the
 * endpoint's signing secret over `"<t>." + the exact raw body`, on Web Crypto. Any `v1` may match
 * (Stripe sends several while a secret rolls); `v0` (sandbox only) and unknown entries are
 * ignored; the timestamp must be within the tolerance (replays of old deliveries fail).
 * Verification happens before the body is parsed: unverified bytes never become an event.
 */
export async function verifyStripeSignature(
  rawBody: Uint8Array,
  header: string | null,
  secret: string,
  nowMs: number,
  toleranceSec = WEBHOOK_TOLERANCE_SEC,
): Promise<ProviderEvent> {
  if (!header) throw new WebhookSignatureError("no signature header");
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t" && timestamp === null && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) candidates.push(value);
  }
  if (timestamp === null) throw new WebhookSignatureError("no timestamp");
  if (candidates.length === 0) throw new WebhookSignatureError("no v1 signature");
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSec) {
    throw new WebhookSignatureError("timestamp outside the tolerance");
  }
  const expected = utf8Encode(await sign(secret, timestamp, rawBody));
  const valid = candidates.some((candidate) => timingSafeEqual(utf8Encode(candidate), expected));
  if (!valid) throw new WebhookSignatureError("signature mismatch");
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(rawBody));
  } catch {
    throw new WebhookSignatureError("the signed body is not JSON");
  }
  const event = toEvent(parsed);
  if (!event) throw new WebhookSignatureError("the signed body is not an event");
  return event;
}

/** The `v1` signature of a body (tests sign recorded fixtures with a test secret). */
export async function sign(secret: string, timestamp: number, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = utf8Encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix, 0);
  signed.set(body, prefix.byteLength);
  return hexEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)));
}

/** A `Stripe-Signature` header for a body, signed at `timestampSec`. */
export async function signatureHeader(
  secret: string,
  body: Uint8Array,
  timestampSec: number,
): Promise<string> {
  return `t=${timestampSec},v1=${await sign(secret, timestampSec, body)}`;
}
