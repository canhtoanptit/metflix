import { describe, expect, it } from "vitest";
import type { DeliveredEmail, EmailMessage, EmailSender } from "../ports/email-sender.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

export interface EmailSenderHarness extends HarnessBase {
  sender: EmailSender;
  /**
   * What actually went out to `to`, oldest first (memory: the outbox; SMTP: Mailpit's API; an
   * HTTP provider: its test mode's message list).
   */
  delivered(to: string): Promise<DeliveredEmail[]>;
}

/** Contract every `EmailSender` adapter must pass. */
export function describeEmailSenderContract(
  name: string,
  factory: HarnessFactory<EmailSenderHarness>,
): void {
  describe(`EmailSender contract: ${name}`, () => {
    const h = useHarness(factory);
    const unique = () => crypto.randomUUID();
    const message = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
      to: `member-${unique()}@example.test`,
      subject: "Verify your email",
      html: '<p>Confirm: <a href="https://webflix.test/verify?token=abc">verify</a></p>',
      text: "Confirm: https://webflix.test/verify?token=abc",
      template: "verify-email",
      ...overrides,
    });

    it("delivers a message once and returns its id", async () => {
      const sent = message();
      const result = await h().sender.send(sent, { idempotencyKey: unique() });
      expect(result.deduplicated).toBe(false);
      expect(result.messageId).toBeTruthy();
      const delivered = await h().delivered(sent.to);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        to: sent.to,
        subject: sent.subject,
        text: sent.text,
        template: "verify-email",
        messageId: result.messageId,
      });
    });

    it("delivers at most once per idempotency key (a retried job sends nothing new)", async () => {
      const sent = message();
      const key = unique();
      const first = await h().sender.send(sent, { idempotencyKey: key });
      const again = await h().sender.send(sent, { idempotencyKey: key });
      expect(again).toEqual({ messageId: first.messageId, deduplicated: true });
      expect(await h().delivered(sent.to)).toHaveLength(1);
    });

    it("sends two messages under two keys", async () => {
      const to = `member-${unique()}@example.test`;
      await h().sender.send(message({ to }), { idempotencyKey: unique() });
      await h().sender.send(message({ to, subject: "Welcome", template: "welcome" }), {
        idempotencyKey: unique(),
      });
      expect((await h().delivered(to)).map((email) => email.subject)).toEqual([
        "Verify your email",
        "Welcome",
      ]);
    });

    it("keeps UTF-8 subjects and bodies intact", async () => {
      const sent = message({ subject: "Bienvenue chez Webflix, Zoë 🎬", text: "Ça marche: 東京" });
      await h().sender.send(sent, { idempotencyKey: unique() });
      const [delivered] = await h().delivered(sent.to);
      expect(delivered?.subject).toBe(sent.subject);
      expect(delivered?.text).toBe(sent.text);
    });

    it("refuses header injection and invalid addresses, and sends nothing", async () => {
      const to = `member-${unique()}@example.test`;
      for (const broken of [
        message({ to: `${to}\r\nBcc: victim@example.test` }),
        message({ to, subject: "Hi\r\nBcc: victim@example.test" }),
        message({ to, from: "x@example.test\nBcc: victim@example.test" }),
        message({ to: "not-an-address" }),
        message({ to, subject: "   " }),
      ]) {
        await expect(h().sender.send(broken, { idempotencyKey: unique() })).rejects.toThrow();
      }
      expect(await h().delivered(to)).toEqual([]);
    });
  });
}
