/**
 * Provider webhooks for the suppression list (§8.2: bounces and complaints stop further mail).
 * The raw body is verified before anything is parsed. Resend signs its webhooks with Svix
 * (`svix-id`, `svix-timestamp`, `svix-signature`: HMAC-SHA256 over `id.timestamp.body` with the
 * base64 secret after `whsec_`), with a five-minute tolerance against replays.
 */

export interface SuppressionEvent {
  address: string;
  reason: "bounce" | "complaint";
}

export class EmailWebhookError extends Error {
  override readonly name = "EmailWebhookError";
}

/** Replayed or delayed deliveries older (or newer) than this are refused. */
export const EMAIL_WEBHOOK_TOLERANCE_SEC = 5 * 60;

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

/** Svix's signature over the exact bytes received. */
export async function svixSignature(
  secret: string,
  id: string,
  timestamp: string,
  body: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base64Bytes(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  let binary = "";
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/**
 * Verify a Resend webhook and return the addresses to suppress. Throws `EmailWebhookError` for
 * a missing or wrong signature, a timestamp outside the tolerance, or a body that is not JSON.
 */
export async function parseResendWebhook(input: {
  secret: string;
  headers: { get(name: string): string | null };
  body: Uint8Array;
  nowSec: number;
}): Promise<SuppressionEvent[]> {
  const id = input.headers.get("svix-id");
  const timestamp = input.headers.get("svix-timestamp");
  const signatures = input.headers.get("svix-signature");
  if (!id || !timestamp || !signatures || id.length > 256) {
    throw new EmailWebhookError("missing signature headers");
  }
  if (!/^\d{1,12}$/.test(timestamp)) throw new EmailWebhookError("invalid timestamp");
  if (Math.abs(input.nowSec - Number(timestamp)) > EMAIL_WEBHOOK_TOLERANCE_SEC) {
    throw new EmailWebhookError("timestamp outside the tolerance");
  }
  let expected: Uint8Array<ArrayBuffer>;
  try {
    expected = base64Bytes(await svixSignature(input.secret, id, timestamp, input.body));
  } catch {
    throw new EmailWebhookError("unusable secret");
  }
  const valid = signatures.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) return false;
    try {
      return constantTimeEqual(base64Bytes(value), expected);
    } catch {
      return false;
    }
  });
  if (!valid) throw new EmailWebhookError("signature mismatch");

  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder().decode(input.body));
  } catch {
    throw new EmailWebhookError("body is not JSON");
  }
  if (typeof event !== "object" || event === null) return [];
  const { type, data } = event as { type?: unknown; data?: { to?: unknown } };
  const reason =
    type === "email.bounced" ? "bounce" : type === "email.complained" ? "complaint" : null;
  if (reason === null) return [];
  const recipients = Array.isArray(data?.to)
    ? data.to
    : typeof data?.to === "string"
      ? [data.to]
      : [];
  return recipients
    .filter((address): address is string => typeof address === "string")
    .map((address) => address.trim().toLowerCase())
    .filter((address) => address.length <= 254 && ADDRESS.test(address))
    .map((address) => ({ address, reason }));
}
