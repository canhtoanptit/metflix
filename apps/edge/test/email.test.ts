/**
 * The email senders the Worker composes, through the `EmailSender` contract inside workerd: the
 * HTTP provider sender (Resend's API, against a fake) and the D1 outbox of local Cloudflare (the
 * mailbox read-back across isolates).
 */
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createOutboxEmailSender,
  createUuidV7Generator,
  type DeliveredEmail,
  type EmailTemplate,
  systemClock,
} from "@webflix/core";
import { describeEmailSenderContract } from "@webflix/core/testing";
import { createIdentityRepository } from "@webflix/db";
import { createD1Database } from "@webflix/db/d1";
import { createHttpEmailSender } from "@webflix/email";
import { beforeAll } from "vitest";

const FROM = "Webflix <no-reply@webflix.dev>";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describeEmailSenderContract("HTTP provider (workerd)", () => {
  const byKey = new Map<string, string>();
  const delivered: DeliveredEmail[] = [];
  const sender = createHttpEmailSender({
    apiKey: "re_fake",
    from: FROM,
    fetch: async (request) => {
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
    },
  });
  return { sender, delivered: async (to) => delivered.filter((message) => message.to === to) };
});

describeEmailSenderContract("outbox (D1)", () => {
  const sender = createOutboxEmailSender({
    repository: createIdentityRepository(createD1Database(env.DB)),
    ids: createUuidV7Generator(),
    clock: systemClock,
    from: FROM,
  });
  return { sender, delivered: (to) => sender.listDelivered(to) };
});
