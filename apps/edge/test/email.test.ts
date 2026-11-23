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
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/index.ts";
import { getRuntime } from "../src/runtime.ts";

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

describe("the outbox sender in production (security review L4)", () => {
  it("is refused when the Worker composes: it stores live reset and verification links", () => {
    expect(() =>
      getRuntime({
        ...env,
        WEBFLIX_ENV: "production",
        WEBFLIX_PUBLIC_ORIGIN: "https://webflix.example.com",
        WEBFLIX_EMAIL_SENDER: "outbox",
      } as Env),
    ).toThrow(/WEBFLIX_EMAIL_SENDER=outbox: refused in production/);
  });

  it("stays available outside production (local Cloudflare's mailbox)", () => {
    const runtime = getRuntime({ ...env, WEBFLIX_EMAIL_SENDER: "outbox" } as Env);
    expect(runtime.config.core.environment).not.toBe("production");
    expect(runtime.config.core.identity.emailSender).toBe("outbox");
  });
});
