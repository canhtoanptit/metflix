import { EMAIL_TEMPLATES } from "@webflix/contracts";

/**
 * The message every `EmailSender` takes, and the one validation all of them run before anything
 * leaves the process. `@webflix/core` re-exports these as its `EmailSender` port.
 */

export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export interface EmailMessage {
  to: string;
  /** Default: the deployment's configured sender. A bare address or `Name <address>`. */
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

/**
 * Port: sends one rendered message (milestone 2 §3, §8.2). Sending is a job, so a sender is
 * called at least once per message and must be idempotent: at most one delivery per
 * `idempotencyKey`. The suppression list (bounces) is the caller's to consult.
 */
export interface EmailSender {
  send(message: EmailMessage, options: { idempotencyKey: string }): Promise<EmailSendResult>;
}

/** A message as a test or the mailbox API sees it after delivery. */
export interface DeliveredEmail extends Required<EmailMessage> {
  messageId: string;
  idempotencyKey: string;
  /** Epoch ms. */
  sentAt: number;
}

/**
 * A sender that keeps what it delivered where this deployment can read it back: the local
 * mailbox of the non-production diagnostics surface (`GET /diagnostics/mailbox`). The memory
 * sender (one process) and the D1 outbox (every isolate) are local mailboxes; SMTP and HTTP
 * providers are not.
 */
export interface LocalMailbox {
  /** Delivered messages for `to` (case-insensitive), oldest first, from `since` (epoch ms). */
  listDelivered(to: string, since?: number): Promise<DeliveredEmail[]>;
}

export function isLocalMailbox(sender: EmailSender): sender is EmailSender & LocalMailbox {
  return typeof (sender as Partial<LocalMailbox>).listDelivered === "function";
}

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const LINE_BREAK = /[\r\n]/;
/** A display name: printable, without the characters that would end or restructure the header. */
const DISPLAY_NAME = /^[^\r\n\0<>"\\]{1,100}$/;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** True for a bare address (`someone@example.com`) that is safe in an SMTP envelope and header. */
export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && ADDRESS.test(value);
}

/**
 * `Name <address>` or a bare address, split. Null when it is neither (or would inject a header).
 */
export function parseMailbox(value: string): { name: string | null; address: string } | null {
  if (LINE_BREAK.test(value)) return null;
  const named = /^\s*([^<]*?)\s*<([^<>]+)>\s*$/.exec(value);
  if (named) {
    const [, name = "", address = ""] = named;
    if (!isEmailAddress(address)) return null;
    if (name === "") return { name: null, address };
    return DISPLAY_NAME.test(name) ? { name, address } : null;
  }
  return isEmailAddress(value.trim()) ? { name: null, address: value.trim() } : null;
}

/** Shared validation: every adapter calls it before anything leaves the process. */
export function assertEmailMessage(message: EmailMessage, idempotencyKey: string): void {
  if (
    typeof message.to !== "string" ||
    LINE_BREAK.test(message.to) ||
    !isEmailAddress(message.to)
  ) {
    throw new TypeError("Invalid to address");
  }
  if (message.from !== undefined && parseMailbox(message.from) === null) {
    throw new TypeError("Invalid from address");
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
