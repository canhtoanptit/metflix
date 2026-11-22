/**
 * The HTTP provider sender (§8.2, §9: k8s and Cloudflare production). Speaks Resend's REST API
 * (`POST /emails`, bearer key, JSON, `Idempotency-Key`), fetch only, so it runs on Node and on
 * Workers. At most one delivery per key: the provider deduplicates a repeated key itself (for 24
 * hours), and this process remembers the keys it sent so a repeat answers `deduplicated: true`
 * without calling the provider again.
 */
import {
  assertEmailMessage,
  type EmailMessage,
  type EmailSender,
  type EmailSendResult,
} from "./message.ts";

export type HttpFetch = (request: Request) => Promise<Response>;

export interface HttpEmailSenderOptions {
  /** Default `https://api.resend.com/emails`. */
  endpoint?: string;
  apiKey: string;
  /** The sender of every message without its own `from`: `Name <address>` or an address. */
  from: string;
  fetch?: HttpFetch;
  /** Per request. Default 10 s. */
  timeoutMs?: number;
  /** Keys remembered in this process. Default 10 000. */
  rememberKeys?: number;
}

export class EmailDeliveryError extends Error {
  override readonly name = "EmailDeliveryError";
  /** The provider's HTTP status, or null when it could not be reached. */
  readonly status: number | null;

  constructor(message: string, status: number | null, options?: { cause?: unknown }) {
    super(message, options);
    this.status = status;
  }
}

export function createHttpEmailSender(options: HttpEmailSenderOptions): EmailSender {
  const endpoint = options.endpoint ?? "https://api.resend.com/emails";
  const fetcher: HttpFetch = options.fetch ?? ((request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const capacity = options.rememberKeys ?? 10_000;
  const sent = new Map<string, string>();

  return {
    async send(message: EmailMessage, { idempotencyKey }): Promise<EmailSendResult> {
      const from = message.from ?? options.from;
      assertEmailMessage({ ...message, from }, idempotencyKey);
      const known = sent.get(idempotencyKey);
      if (known !== undefined) return { messageId: known, deduplicated: true };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetcher(
          new Request(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
              from,
              to: [message.to],
              subject: message.subject,
              html: message.html,
              text: message.text,
              tags: [{ name: "template", value: message.template.replaceAll("-", "_") }],
            }),
            signal: controller.signal,
          }),
        );
      } catch (error) {
        throw new EmailDeliveryError("The email provider could not be reached", null, {
          cause: error,
        });
      } finally {
        clearTimeout(timer);
      }
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      if (!response.ok || typeof body?.id !== "string") {
        // Never echo the provider's body: it may quote the message.
        throw new EmailDeliveryError(
          `The email provider answered ${response.status}`,
          response.status,
        );
      }
      sent.set(idempotencyKey, body.id);
      if (sent.size > capacity) {
        const oldest = sent.keys().next().value;
        if (oldest !== undefined) sent.delete(oldest);
      }
      return { messageId: body.id, deduplicated: false };
    },
  };
}
