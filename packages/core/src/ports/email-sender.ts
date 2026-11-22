import { EMAIL_TEMPLATES } from "@webflix/contracts";

/**
 * Port: sends one rendered message (milestone 2 §3, §8.2). In-memory outbox with a mailbox API
 * (dev), SMTP (Mailpit on kind) or an HTTP provider; a D1 outbox for local Cloudflare.
 * Rendering is `packages/email`'s; sending is a job, so this port is called at least once per
 * message and must be idempotent.
 *
 * Contract (`describeEmailSenderContract`):
 * - A message is delivered at most once per `idempotencyKey`: a repeated call answers the
 *   first call's `messageId` with `deduplicated: true` and delivers nothing.
 * - Headers cannot be injected: a recipient, sender or subject with a line break is refused
 *   (`assertEmailMessage`), as is an address that is not one.
 * - UTF-8 subjects and bodies arrive unchanged.
 * - The suppression list (bounces) is the caller's to consult; the port sends what it is given.
 */
export interface EmailSender {
  send(message: EmailMessage, options: { idempotencyKey: string }): Promise<EmailSendResult>;
}

export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export interface EmailMessage {
  to: string;
  /** Default: the deployment's configured sender. */
  from?: string;
  subject: string;
  html: string;
  text: string;
  /** Which template rendered it (logs, the local mailbox, provider tags). */
  template: EmailTemplate;
}

export interface EmailSendResult {
  /** The provider's (or outbox's) id for the message. */
  messageId: string;
  /** True when this idempotency key was already sent: nothing new went out. */
  deduplicated: boolean;
}

/** A message as a test or the mailbox API sees it after delivery. */
export interface DeliveredEmail extends Required<EmailMessage> {
  messageId: string;
  idempotencyKey: string;
  /** Epoch ms. */
  sentAt: number;
}

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const LINE_BREAK = /[\r\n]/;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Shared validation: every adapter calls it before anything leaves the process. */
export function assertEmailMessage(message: EmailMessage, idempotencyKey: string): void {
  for (const [field, value] of [
    ["to", message.to],
    ["from", message.from],
  ] as const) {
    if (value === undefined && field === "from") continue;
    if (typeof value !== "string" || LINE_BREAK.test(value) || !ADDRESS.test(value)) {
      throw new TypeError(`Invalid ${field} address`);
    }
  }
  if (message.subject.trim() === "" || LINE_BREAK.test(message.subject)) {
    throw new TypeError("Subject must be one non-empty line");
  }
  if (message.html === "" || message.text === "") throw new TypeError("Both bodies are required");
  if (!(EMAIL_TEMPLATES as readonly string[]).includes(message.template)) {
    throw new TypeError(`Unknown template "${message.template}"`);
  }
  if (idempotencyKey.length === 0 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new TypeError(`idempotencyKey must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
}

/** Every http(s) link of a message's text and HTML, in order, deduplicated (mailbox API). */
export function emailLinks(message: Pick<EmailMessage, "text" | "html">): string[] {
  const links = [...`${message.text}\n${message.html}`.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(
    (match) => match[0].replaceAll("&amp;", "&"),
  );
  return [...new Set(links)];
}
