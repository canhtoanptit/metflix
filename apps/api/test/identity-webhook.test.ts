/**
 * `POST /api/v1/webhooks/email/{provider}` in the Node runtime with the HTTP email sender: the raw
 * body is verified (Svix-style signature, Resend) before anything is parsed, and a bounce or a
 * complaint suppresses the address.
 */

import { migrateToLatest } from "@webflix/db";
import { svixSignature } from "@webflix/email";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/config.ts";
import { createHttpApp, createRuntime, type Runtime } from "../src/runtime.ts";

const SECRET = `whsec_${btoa("a-test-webhook-signing-secret")}`;
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;

beforeAll(async () => {
  const config = loadApiConfig({
    WEBFLIX_DATABASE_URL: "sqlite::memory:",
    WEBFLIX_BLOB_STORE: "memory",
    WEBFLIX_MEDIA_DIR: "none",
    WEBFLIX_LOG_LEVEL: "error",
    WEBFLIX_PAYMENT_PROVIDER: "memory",
    WEBFLIX_EMAIL_SENDER: "http",
    WEBFLIX_EMAIL_HTTP_URL: "http://127.0.0.1:5653/emails",
    WEBFLIX_EMAIL_HTTP_API_KEY: "re_test_key",
    WEBFLIX_EMAIL_WEBHOOK_SECRET: SECRET,
  });
  runtime = createRuntime(config, "api");
  await migrateToLatest(runtime.infra.database);
  app = createHttpApp(runtime);
});

afterAll(async () => {
  await runtime.close();
});

async function deliver(
  body: string,
  options: { provider?: string; secret?: string; timestamp?: number } = {},
) {
  const bytes = new TextEncoder().encode(body);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = await svixSignature(options.secret ?? SECRET, "msg_1", timestamp, bytes);
  return app.request(`/api/v1/webhooks/email/${options.provider ?? "resend"}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "svix-id": "msg_1",
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body: bytes,
  });
}

describe("the email provider's webhook", () => {
  it("suppresses a bounced address after verifying the signature", async () => {
    const response = await deliver(
      JSON.stringify({ type: "email.bounced", data: { to: ["Gone@Example.test"] } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, duplicate: false });
    expect(await runtime.infra.repos.identity.isSuppressed("gone@example.test")).toBe(true);
  });

  it("refuses a bad signature, a stale delivery, and an unknown provider, changing nothing", async () => {
    const body = JSON.stringify({ type: "email.complained", data: { to: ["kept@example.test"] } });
    const forged = await deliver(body, { secret: `whsec_${btoa("not-the-secret")}` });
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { code: string }).code).toBe("webhook_signature_invalid");
    const stale = await deliver(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(stale.status).toBe(400);
    expect((await deliver(body, { provider: "postmark" })).status).toBe(404);
    expect(await runtime.infra.repos.identity.isSuppressed("kept@example.test")).toBe(false);
  });
});
