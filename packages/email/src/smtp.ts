/**
 * The SMTP sender (§9: Mailpit on kind, or any SMTP relay on Kubernetes). Node only (TCP), so it
 * is a separate entry point: `@webflix/email/smtp`. One connection per message (EHLO, optional
 * AUTH PLAIN over implicit TLS only, MAIL FROM, RCPT TO, DATA, QUIT); the message is MIME
 * multipart/alternative with base64 bodies and RFC 2047 encoded headers, so UTF-8 arrives intact
 * and no body line can end the DATA phase. SMTP has no idempotency: this process remembers the
 * keys it delivered; across processes the identity area's job ids keep retries rare and Mailpit
 * duplicates harmless.
 */
import { randomUUID } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import {
  assertEmailMessage,
  type EmailMessage,
  type EmailSender,
  type EmailSendResult,
  parseMailbox,
} from "./message.ts";

export interface SmtpEmailSenderOptions {
  host: string;
  port: number;
  /** `implicit`: TLS from the first byte (port 465). `none`: plain TCP (Mailpit). */
  tls: "none" | "implicit";
  username: string | null;
  password: string | null;
  /** The sender of every message without its own `from`. */
  from: string;
  /** Name announced in EHLO. Default `webflix.local`. */
  clientName?: string;
  /** Per message. Default 15 s. */
  timeoutMs?: number;
  /** Keys remembered in this process. Default 10 000. */
  rememberKeys?: number;
  /** Accept a self-signed certificate (tests). Default false. */
  insecureTls?: boolean;
}

export class SmtpError extends Error {
  override readonly name = "SmtpError";
  /** The server's reply code, or null for a connection problem. */
  readonly code: number | null;

  constructor(message: string, code: number | null) {
    super(message);
    this.code = code;
  }
}

/** RFC 2047 encoded-word (base64, UTF-8), split so no encoded word exceeds 75 characters. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const character of value) {
    const candidate = chunk + character;
    if (Buffer.byteLength(candidate, "utf8") > 45) {
      words.push(chunk);
      chunk = character;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

function mailboxHeader(value: string): { header: string; address: string } {
  const parsed = parseMailbox(value);
  if (!parsed) throw new TypeError("Invalid from address");
  if (parsed.name === null) return { header: `<${parsed.address}>`, address: parsed.address };
  const name = /^[\x20-\x7e]*$/.test(parsed.name) ? `"${parsed.name}"` : encodeHeader(parsed.name);
  return { header: `${name} <${parsed.address}>`, address: parsed.address };
}

function base64Lines(value: string): string {
  return (
    Buffer.from(value, "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
}

/** The full message, CRLF line endings, dot-stuffed for the DATA phase. */
export function formatSmtpMessage(
  message: Required<EmailMessage>,
  messageId: string,
  date: Date,
): string {
  const from = mailboxHeader(message.from);
  const boundary = `webflix-${randomUUID()}`;
  const lines = [
    `From: ${from.header}`,
    `To: <${message.to}>`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    `X-Webflix-Template: ${message.template}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.html),
    `--${boundary}--`,
    "",
  ];
  return lines
    .join("\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

/** A minimal SMTP conversation over one socket: send a command, read the (multi-line) reply. */
class Conversation {
  private buffer = "";
  private waiting: ((reply: { code: number; text: string } | Error) => void) | null = null;
  private failure: Error | null = null;
  private readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      this.buffer += data;
      this.flush();
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () =>
      this.fail(new SmtpError("The SMTP server closed the connection", null)),
    );
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const waiter = this.waiting;
    this.waiting = null;
    waiter?.(this.failure);
  }

  private flush(): void {
    if (!this.waiting) return;
    // A reply is complete at a line `ddd <text>` (a space after the code, not a dash).
    const lines = this.buffer.split("\r\n");
    for (let index = 0; index < lines.length - 1; index += 1) {
      const line = lines[index] ?? "";
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = lines.slice(0, index + 1);
        this.buffer = lines.slice(index + 1).join("\r\n");
        const waiter = this.waiting;
        this.waiting = null;
        waiter({ code: Number(line.slice(0, 3)), text: reply.join("\n") });
        return;
      }
    }
  }

  read(): Promise<{ code: number; text: string }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = (reply) => (reply instanceof Error ? reject(reply) : resolve(reply));
      this.flush();
    });
  }

  async command(line: string | null, expected: readonly number[]): Promise<string> {
    if (line !== null) this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    if (!expected.includes(reply.code)) {
      // The reply may quote the command; the command never carries a secret except AUTH.
      throw new SmtpError(`SMTP server answered ${reply.code}`, reply.code);
    }
    return reply.text;
  }
}

export function createSmtpEmailSender(options: SmtpEmailSenderOptions): EmailSender {
  if (options.username !== null && options.tls === "none") {
    throw new TypeError("SMTP credentials are only sent over TLS");
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const capacity = options.rememberKeys ?? 10_000;
  const sent = new Map<string, string>();

  async function deliver(message: Required<EmailMessage>, messageId: string): Promise<void> {
    const socket: Socket =
      options.tls === "implicit"
        ? connectTls({
            host: options.host,
            port: options.port,
            servername: options.host,
            rejectUnauthorized: !options.insecureTls,
          })
        : connectTcp({ host: options.host, port: options.port });
    socket.setTimeout(timeoutMs, () => socket.destroy(new SmtpError("SMTP timed out", null)));
    const smtp = new Conversation(socket);
    try {
      await smtp.command(null, [220]);
      await smtp.command(`EHLO ${options.clientName ?? "webflix.local"}`, [250]);
      if (options.username !== null && options.password !== null) {
        const credentials = Buffer.from(
          `\u0000${options.username}\u0000${options.password}`,
          "utf8",
        ).toString("base64");
        await smtp.command(`AUTH PLAIN ${credentials}`, [235]);
      }
      await smtp.command(`MAIL FROM:<${mailboxHeader(message.from).address}>`, [250]);
      await smtp.command(`RCPT TO:<${message.to}>`, [250, 251]);
      await smtp.command("DATA", [354]);
      await smtp.command(`${formatSmtpMessage(message, messageId, new Date())}\r\n.`, [250]);
      await smtp.command("QUIT", [221]).catch(() => undefined);
    } finally {
      socket.destroy();
    }
  }

  return {
    async send(message: EmailMessage, { idempotencyKey }): Promise<EmailSendResult> {
      const complete: Required<EmailMessage> = { ...message, from: message.from ?? options.from };
      assertEmailMessage(complete, idempotencyKey);
      const known = sent.get(idempotencyKey);
      if (known !== undefined) return { messageId: known, deduplicated: true };
      const domain = mailboxHeader(complete.from).address.split("@")[1] ?? "webflix.local";
      const messageId = `${randomUUID()}@${domain}`;
      await deliver(complete, messageId);
      sent.set(idempotencyKey, messageId);
      if (sent.size > capacity) {
        const oldest = sent.keys().next().value;
        if (oldest !== undefined) sent.delete(oldest);
      }
      return { messageId, deduplicated: false };
    },
  };
}
