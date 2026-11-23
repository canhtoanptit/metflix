import { EMAIL_TEMPLATES } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import {
  assertEmailMessage,
  createHttpEmailSender,
  EmailDeliveryError,
  type EmailTemplateData,
  EmailWebhookError,
  emailLinks,
  escapeHtml,
  parseMailbox,
  parseResendWebhook,
  renderEmail,
  svixSignature,
} from "../src/index.ts";

const AT = "2026-11-22T14:05:00.000Z";

/** One valid data set per template. */
const SAMPLES: { [T in keyof EmailTemplateData]: EmailTemplateData[T] } = {
  "verify-email": { link: "https://webflix.test/verify-email#token=abc", expiresAt: AT },
  "reset-password": { link: "https://webflix.test/reset-password#token=abc", expiresAt: AT },
  welcome: { signInMethod: "Google" },
  receipt: {
    planName: "Standard",
    amount: { amountMinor: 1549, currency: "USD" },
    paidAt: AT,
    periodEnd: AT,
    invoiceUrl: null,
  },
  "payment-failed": {
    planName: "Basic",
    amount: { amountMinor: 799, currency: "USD" },
    retryAt: AT,
    updateUrl: "https://webflix.test/account",
  },
  "trial-ending": {
    planName: "Premium",
    trialEndsAt: AT,
    amount: { amountMinor: 2299, currency: "USD" },
    manageUrl: "https://webflix.test/account",
  },
  "plan-changed": { fromPlan: "Basic", toPlan: "Premium", effectiveAt: AT },
  cancellation: { planName: "Basic", accessUntil: AT, restartUrl: "https://webflix.test/account" },
  "new-sign-in": { device: "Chrome on macOS", method: "a password", at: AT },
  "security-change": {
    change: "password-reset",
    at: AT,
    detail: null,
    manageUrl: "https://webflix.test/account",
  },
  "data-export-ready": { link: "https://webflix.test/export/1", expiresAt: AT },
  "account-deletion-scheduled": {
    scheduledFor: AT,
    keepUrl: "https://webflix.test/account/privacy",
  },
  "account-deletion-canceled": { manageUrl: "https://webflix.test/account" },
};

describe("the account deletion emails", () => {
  it("say when the account will be deleted and how to keep it; then that nothing will be", () => {
    const scheduled = renderEmail("account-deletion-scheduled", {
      scheduledFor: AT,
      keepUrl: "https://webflix.test/account/privacy",
    });
    expect(scheduled.subject).toBe("Your Webflix account will be deleted");
    // A day in the member app's words (the time does not matter for a deletion date).
    expect(scheduled.text).toContain("November 22, 2026");
    expect(scheduled.text).toContain("Keep my account");
    expect(emailLinks(scheduled)).toEqual(["https://webflix.test/account/privacy"]);
    // Never the cancellation email's promise: access ends at the erasure, no restart.
    expect(scheduled.text).not.toMatch(/keep watching|restart/i);
    const canceled = renderEmail("account-deletion-canceled", {
      manageUrl: "https://webflix.test/account",
    });
    expect(canceled.subject).toBe("Your Webflix account will not be deleted");
    expect(canceled.text).toContain("nothing will be deleted");
    expect(emailLinks(canceled)).toEqual(["https://webflix.test/account"]);
  });
});

describe("templates", () => {
  it("render every template to a one-line subject, HTML and text, in our own brand", () => {
    for (const template of EMAIL_TEMPLATES) {
      const rendered = renderEmail(template, SAMPLES[template] as never);
      expect(rendered.subject, template).toMatch(/^[^\r\n]+$/);
      expect(rendered.html, template).toContain("WEBFLIX");
      expect(rendered.text, template).toContain("WEBFLIX");
      expect(`${rendered.html}${rendered.text}`.toLowerCase(), template).not.toContain("netflix");
      expect(
        () => assertEmailMessage({ to: "a@example.test", template, ...rendered }, "k"),
        template,
      ).not.toThrow();
    }
  });

  it("escape every interpolated value and keep the link usable in both bodies", () => {
    const rendered = renderEmail("new-sign-in", {
      device: '<script>alert("x")</script>',
      method: "a & b",
      at: AT,
    });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(rendered.html).toContain("a &amp; b");
    const reset = renderEmail("reset-password", {
      link: "https://webflix.test/reset-password#token=t0k",
      expiresAt: AT,
    });
    expect(emailLinks(reset)).toEqual(["https://webflix.test/reset-password#token=t0k"]);
    // Where the time matters (a link that expires within the hour), in UTC and said so.
    expect(reset.text).toContain("November 22, 2026 at 2:05 PM UTC");
  });

  it("refuse a link that is not http(s)", () => {
    expect(() =>
      renderEmail("verify-email", { link: "javascript:alert(1)", expiresAt: AT }),
    ).toThrow(TypeError);
    expect(() => renderEmail("verify-email", { link: "/relative", expiresAt: AT })).toThrow(
      TypeError,
    );
  });

  it("escapeHtml covers the five characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("addresses", () => {
  it("parses a mailbox and refuses anything that could inject a header", () => {
    expect(parseMailbox("Webflix <no-reply@webflix.dev>")).toEqual({
      name: "Webflix",
      address: "no-reply@webflix.dev",
    });
    expect(parseMailbox("no-reply@webflix.dev")).toEqual({
      name: null,
      address: "no-reply@webflix.dev",
    });
    for (const bad of [
      "Webflix\r\nBcc: x@y.z <a@b.c>",
      "a@b.c\nBcc: x@y.z",
      'Bad "name" <a@b.c>',
      "<not-an-address>",
    ]) {
      expect(parseMailbox(bad), bad).toBeNull();
    }
  });
});

describe("HTTP sender (Resend's API)", () => {
  it("posts JSON with the bearer key and the idempotency key, and deduplicates a repeat locally", async () => {
    const requests: Request[] = [];
    const sender = createHttpEmailSender({
      endpoint: "https://api.resend.test/emails",
      apiKey: "re_test_key",
      from: "Webflix <no-reply@webflix.dev>",
      fetch: async (request) => {
        requests.push(request.clone());
        return Response.json({ id: "msg-1" });
      },
    });
    const message = {
      to: "a@example.test",
      subject: "Hi",
      html: "<p>hi</p>",
      text: "hi",
      template: "welcome" as const,
    };
    expect(await sender.send(message, { idempotencyKey: "k-1" })).toEqual({
      messageId: "msg-1",
      deduplicated: false,
    });
    expect(await sender.send(message, { idempotencyKey: "k-1" })).toEqual({
      messageId: "msg-1",
      deduplicated: true,
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.headers.get("Authorization")).toBe("Bearer re_test_key");
    expect(request?.headers.get("Idempotency-Key")).toBe("k-1");
    expect(await request?.json()).toMatchObject({
      from: "Webflix <no-reply@webflix.dev>",
      to: ["a@example.test"],
      subject: "Hi",
      tags: [{ name: "template", value: "welcome" }],
    });
  });

  it("fails (for the job to retry) without echoing what the provider said", async () => {
    const sender = createHttpEmailSender({
      apiKey: "re_test_key",
      from: "no-reply@webflix.dev",
      fetch: async () => Response.json({ message: "secret detail: the body" }, { status: 422 }),
    });
    const error = await sender
      .send(
        { to: "a@example.test", subject: "Hi", html: "<p>x</p>", text: "x", template: "welcome" },
        { idempotencyKey: "k" },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as Error).message).not.toContain("secret");
    expect((error as EmailDeliveryError).status).toBe(422);
  });
});

describe("Resend webhooks (Svix signatures)", () => {
  const secret = `whsec_${btoa("a-webhook-signing-secret-of-some-length")}`;
  const now = 1_790_000_000;
  const body = new TextEncoder().encode(
    JSON.stringify({ type: "email.bounced", data: { to: ["Bounced@Example.test"], subject: "x" } }),
  );
  async function headers(overrides: Record<string, string> = {}) {
    const id = "msg_2";
    const timestamp = String(now);
    return new Headers({
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${await svixSignature(secret, id, timestamp, body)}`,
      ...overrides,
    });
  }

  it("verifies the exact bytes and returns the addresses to suppress", async () => {
    expect(
      await parseResendWebhook({ secret, headers: await headers(), body, nowSec: now }),
    ).toEqual([{ address: "bounced@example.test", reason: "bounce" }]);
  });

  it("refuses a wrong signature, an altered body, a replay outside the tolerance, missing headers", async () => {
    const attempts = [
      async () =>
        parseResendWebhook({
          secret,
          headers: await headers({ "svix-signature": "v1,AAAA" }),
          body,
          nowSec: now,
        }),
      async () =>
        parseResendWebhook({
          secret,
          headers: await headers(),
          body: new TextEncoder().encode("{}"),
          nowSec: now,
        }),
      async () => parseResendWebhook({ secret, headers: await headers(), body, nowSec: now + 301 }),
      async () =>
        parseResendWebhook({
          secret: `whsec_${btoa("another-secret-entirely")}`,
          headers: await headers(),
          body,
          nowSec: now,
        }),
      async () => parseResendWebhook({ secret, headers: new Headers(), body, nowSec: now }),
    ];
    for (const attempt of attempts)
      await expect(attempt()).rejects.toBeInstanceOf(EmailWebhookError);
  });
});

describe("dates and amounts", () => {
  it("say amounts as the member app does, in the subject too", () => {
    const receipt = renderEmail("receipt", {
      planName: "Standard",
      amount: { amountMinor: 1299, currency: "USD" },
      paidAt: AT,
      periodEnd: "2026-12-22T14:05:00.000Z",
      invoiceUrl: null,
    });
    expect(receipt.subject).toBe("Your Webflix receipt: $12.99");
    expect(receipt.text).toContain(
      "We received $12.99 for your Standard plan on November 22, 2026.",
    );
    expect(receipt.text).toContain("paid until December 22, 2026.");
    expect(receipt.text).not.toMatch(/USD|UTC/);
    const trial = renderEmail("trial-ending", {
      planName: "Premium",
      trialEndsAt: AT,
      amount: { amountMinor: 1899, currency: "USD" },
      manageUrl: "https://webflix.test/account",
    });
    expect(trial.text).toContain(
      "After that you will be charged $18.99 a month unless you cancel.",
    );
    // A currency without minor units keeps none.
    const yen = renderEmail("payment-failed", {
      planName: "Basic",
      amount: { amountMinor: 1200, currency: "JPY" },
      retryAt: null,
      updateUrl: "https://webflix.test/account",
    });
    expect(yen.text).toContain("We could not collect ¥1,200 for your Basic plan.");
  });

  it("say what they can when the amount isn't known", () => {
    const failed = renderEmail("payment-failed", {
      planName: "Basic",
      amount: null,
      retryAt: null,
      updateUrl: "https://webflix.test/account",
    });
    expect(failed.text).toContain("We could not collect the payment for your Basic plan.");
  });

  it("use US spelling", () => {
    const canceled = renderEmail("cancellation", {
      planName: "Basic",
      accessUntil: AT,
      restartUrl: "https://webflix.test/account",
    });
    expect(canceled.subject).toBe("Your Webflix membership is canceled");
    expect(canceled.text).not.toMatch(/cancelled/);
  });
});
