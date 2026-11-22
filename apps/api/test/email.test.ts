/**
 * The email senders the Node runtime composes, each through the `EmailSender` contract: SMTP
 * (Mailpit on kind) against a local SMTP server speaking the protocol, the HTTP provider sender
 * against a Resend-shaped fake, and the outbox on SQLite (the mailbox read-back). Mailpit itself
 * needs Docker and is left to the platform step.
 */
import { createServer, type Server, type Socket } from "node:net";
import {
  createOutboxEmailSender,
  createUuidV7Generator,
  type DeliveredEmail,
  type EmailTemplate,
  systemClock,
} from "@webflix/core";
import { describeEmailSenderContract } from "@webflix/core/testing";
import { createIdentityRepository, migrateToLatest } from "@webflix/db";
import { createSqliteDatabase } from "@webflix/db/sqlite";
import { createHttpEmailSender } from "@webflix/email";
import { createSmtpEmailSender, SmtpError } from "@webflix/email/smtp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// --- A local SMTP server (RFC 5321's happy path, and a refusal on demand) ----------------------

interface Received {
  from: string;
  to: string[];
  data: string;
}

/** Decodes RFC 2047 encoded words (adjacent ones join without the folding whitespace). */
function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, encoded: string) =>
      Buffer.from(encoded, "base64").toString("utf8"),
    );
}

function parseMessage(raw: string, received: Received): DeliveredEmail {
  const [head = "", ...rest] = raw.split("\r\n\r\n");
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const at = line.indexOf(":");
    headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
  }
  const body = rest.join("\r\n\r\n");
  const part = (type: string) => {
    const match = new RegExp(
      `Content-Type: ${type}; charset=utf-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n--`,
    ).exec(body);
    return Buffer.from((match?.[1] ?? "").replace(/\r\n/g, ""), "base64").toString("utf8");
  };
  return {
    to: received.to[0] ?? "",
    from: decodeHeader(headers.get("from") ?? ""),
    subject: decodeHeader(headers.get("subject") ?? ""),
    text: part("text/plain"),
    html: part("text/html"),
    template: (headers.get("x-webflix-template") ?? "welcome") as EmailTemplate,
    messageId: (headers.get("message-id") ?? "").replace(/^<|>$/g, ""),
    idempotencyKey: "",
    sentAt: Date.now(),
  };
}

function startSmtpServer(options: { refuseRecipient?: string } = {}) {
  const received: Received[] = [];
  const server: Server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    socket.write("220 smtp.test ESMTP\r\n");
    let buffer = "";
    let inData = false;
    let envelope: Received = { from: "", to: [], data: "" };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          const data = buffer
            .slice(0, end)
            .split("\r\n")
            .map((line) => (line.startsWith("..") ? line.slice(1) : line))
            .join("\r\n");
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push({ ...envelope, data });
          envelope = { from: "", to: [], data: "" };
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const mail = /^MAIL FROM:<([^>]*)>/i.exec(line);
        const rcpt = /^RCPT TO:<([^>]*)>/i.exec(line);
        if (/^EHLO /i.test(line)) socket.write("250-smtp.test\r\n250 8BITMIME\r\n");
        else if (mail) {
          envelope.from = mail[1] ?? "";
          socket.write("250 2.1.0 ok\r\n");
        } else if (rcpt) {
          if (rcpt[1] === options.refuseRecipient) socket.write("550 5.1.1 no such user\r\n");
          else {
            envelope.to.push(rcpt[1] ?? "");
            socket.write("250 2.1.5 ok\r\n");
          }
        } else if (/^DATA$/i.test(line)) {
          inData = true;
          socket.write("354 end with <CRLF>.<CRLF>\r\n");
        } else if (/^QUIT$/i.test(line)) {
          socket.end("221 2.0.0 bye\r\n");
        } else socket.write("502 5.5.2 not implemented\r\n");
      }
    });
  });
  return { server, received };
}

/** This engineer's assigned ports (5650-5669). */
const SMTP_PORT = 5651;
const REFUSING_PORT = 5652;
const smtp = startSmtpServer();
const refusing = startSmtpServer({ refuseRecipient: "nobody@example.test" });

beforeAll(async () => {
  await new Promise<void>((resolve) => smtp.server.listen(SMTP_PORT, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => refusing.server.listen(REFUSING_PORT, "127.0.0.1", resolve));
});
afterAll(async () => {
  await new Promise((resolve) => smtp.server.close(resolve));
  await new Promise((resolve) => refusing.server.close(resolve));
});

const FROM = "Webflix <no-reply@webflix.dev>";

describeEmailSenderContract("SMTP (Node)", () => ({
  sender: createSmtpEmailSender({
    host: "127.0.0.1",
    port: SMTP_PORT,
    tls: "none",
    username: null,
    password: null,
    from: FROM,
  }),
  async delivered(to) {
    return smtp.received
      .filter((entry) => entry.to.includes(to))
      .map((entry) => parseMessage(entry.data, entry));
  },
}));

describe("SMTP sender", () => {
  it("speaks the envelope with the bare address, the header with the display name", async () => {
    const sender = createSmtpEmailSender({
      host: "127.0.0.1",
      port: SMTP_PORT,
      tls: "none",
      username: null,
      password: null,
      from: FROM,
    });
    const to = `envelope-${crypto.randomUUID()}@example.test`;
    await sender.send(
      {
        to,
        subject: "Hello",
        html: "<p>.leading dot</p>",
        text: ".leading dot\nsecond",
        template: "welcome",
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    const entry = smtp.received.find((candidate) => candidate.to.includes(to));
    expect(entry?.from).toBe("no-reply@webflix.dev");
    const message = parseMessage(entry?.data ?? "", entry ?? { from: "", to: [], data: "" });
    expect(message.from).toBe('"Webflix" <no-reply@webflix.dev>');
    expect(message.text).toBe(".leading dot\nsecond");
  });

  it("fails when the server refuses, and does not remember the key as sent", async () => {
    const sender = createSmtpEmailSender({
      host: "127.0.0.1",
      port: REFUSING_PORT,
      tls: "none",
      username: null,
      password: null,
      from: FROM,
    });
    const message = {
      to: "nobody@example.test",
      subject: "Hi",
      html: "<p>x</p>",
      text: "x",
      template: "welcome" as const,
    };
    await expect(sender.send(message, { idempotencyKey: "k-refused" })).rejects.toBeInstanceOf(
      SmtpError,
    );
    await expect(sender.send(message, { idempotencyKey: "k-refused" })).rejects.toBeInstanceOf(
      SmtpError,
    );
  });

  it("never sends credentials over plain TCP", () => {
    expect(() =>
      createSmtpEmailSender({
        host: "127.0.0.1",
        port: SMTP_PORT,
        tls: "none",
        username: "u",
        password: "p",
        from: FROM,
      }),
    ).toThrow(TypeError);
  });
});

// --- The HTTP provider sender against a Resend-shaped fake --------------------------------

function fakeResend() {
  const byKey = new Map<string, string>();
  const delivered: DeliveredEmail[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    if (request.headers.get("Authorization") !== "Bearer re_fake")
      return new Response(null, { status: 401 });
    const key = request.headers.get("Idempotency-Key") ?? "";
    const existing = byKey.get(key);
    if (existing) return Response.json({ id: existing });
    const body = (await request.json()) as {
      from: string;
      to: string[];
      subject: string;
      html: string;
      text: string;
      tags: Array<{ value: string }>;
    };
    const id = crypto.randomUUID();
    byKey.set(key, id);
    for (const to of body.to) {
      delivered.push({
        to,
        from: body.from,
        subject: body.subject,
        html: body.html,
        text: body.text,
        template: (body.tags[0]?.value ?? "welcome").replaceAll("_", "-") as EmailTemplate,
        messageId: id,
        idempotencyKey: key,
        sentAt: Date.now(),
      });
    }
    return Response.json({ id });
  };
  return { fetch, delivered };
}

describeEmailSenderContract("HTTP provider (Node)", () => {
  const provider = fakeResend();
  return {
    sender: createHttpEmailSender({ apiKey: "re_fake", from: FROM, fetch: provider.fetch }),
    delivered: async (to) => provider.delivered.filter((message) => message.to === to),
  };
});

describeEmailSenderContract("outbox (SQLite)", async () => {
  const database = createSqliteDatabase({ path: ":memory:" });
  await migrateToLatest(database);
  const sender = createOutboxEmailSender({
    repository: createIdentityRepository(database),
    ids: createUuidV7Generator(),
    clock: systemClock,
    from: FROM,
  });
  return { sender, delivered: (to) => sender.listDelivered(to), cleanup: () => database.close() };
});
