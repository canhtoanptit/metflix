/**
 * The Worker as production configures it (wrangler.jsonc env.production: Stripe, the HTTP email
 * sender, the event lake, the staff API closed), composed in workerd and asked through the real
 * gateway. Nothing here reaches the network: composition and these routes make no provider call.
 * The node project checks the same vars against wrangler.jsonc itself (test/node/config.test.ts).
 */
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type Env, handleFetch } from "../src/index.ts";
import { getRuntime } from "../src/runtime.ts";

const ORIGIN = "https://webflix.example.com";

/** env.production's vars that differ from the local ones, and stub secrets (never real). */
const production: Env = {
  ...env,
  WEBFLIX_ENV: "production",
  WEBFLIX_PUBLIC_ORIGIN: ORIGIN,
  WEBFLIX_RELEASE: "0123456789ab",
  WEBFLIX_EVENT_SINK: "lake",
  WEBFLIX_EMAIL_SENDER: "http",
  WEBFLIX_PAYMENT_PROVIDER: "stripe",
  WEBFLIX_STAFF_VERIFIER: "",
  WEBFLIX_STAFF_ISSUER: "",
  WEBFLIX_MEDIA_TOKEN_KEYS: `k1:${"m".repeat(43)}`,
  WEBFLIX_PSEUDONYM_KEY: "p".repeat(43),
  WEBFLIX_EMAIL_HTTP_API_KEY: `re_${"e".repeat(30)}`,
  WEBFLIX_EMAIL_WEBHOOK_SECRET: `whsec_${"w".repeat(32)}`,
  STRIPE_SECRET_KEY: `sk_live_${"s".repeat(24)}`,
  STRIPE_PUBLISHABLE_KEY: `pk_live_${"s".repeat(24)}`,
  STRIPE_WEBHOOK_SECRET: `whsec_${"h".repeat(32)}`,
} as Env;

async function get(path: string, headers: Record<string, string> = {}) {
  const response = await handleFetch(
    new Request(`${ORIGIN}${path}`, { headers: { "CF-Connecting-IP": "192.0.2.80", ...headers } }),
    production,
    createExecutionContext(),
  );
  return { status: response.status, headers: response.headers, text: await response.text() };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("the Worker as configured for production", () => {
  it("composes: Stripe, the HTTP email sender, the lake, the staff API closed", () => {
    const { config } = getRuntime(production);
    expect(config.core.environment).toBe("production");
    expect(config.core.billing.paymentProvider).toBe("stripe");
    expect(config.core.identity.emailSender).toBe("http");
    expect(config.core.events.eventSink).toBe("lake");
    expect(config.core.events.serverRelease).toBe("0123456789ab");
    expect(config.core.admin.staffVerifier).toBe("memory");
  });

  it("gives the browser Stripe's publishable key, never a secret", async () => {
    const response = await get("/api/v1/billing/config");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({
      provider: "stripe",
      publishableKey: production.STRIPE_PUBLISHABLE_KEY,
    });
    expect(response.text).not.toContain("sk_live_");
    expect(response.text).not.toContain("whsec_");
  });

  it("serves neither the development issuer nor the fake provider's form", async () => {
    for (const path of ["/dev-idp/google/.well-known/openid-configuration", "/_pay/form"]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("Cache-Control"), path).toBe("no-store");
    }
  });

  it("admits nobody to the staff API until an issuer is configured", async () => {
    const response = await get("/api/admin/v1/me", { Authorization: "Bearer not.a.token" });
    expect(response.status).toBe(401);
  });

  it("keeps the mailbox and the diagnostics surfaces closed", async () => {
    expect((await get("/api/v1/diagnostics/mailbox?to=a%40example.test")).status).toBe(404);
  });
});
