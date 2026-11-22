/**
 * Billing in the Worker under workerd, through the Worker's own gateway (`handleFetch`: the
 * fake provider's form at `/_pay/*`, then the app), on D1 with the generated migrations, the
 * fake provider's state in D1, webhooks signed by the fake and verified by the Worker, jobs
 * captured and delivered on demand to this runtime's processor (the Queues consumer's work).
 */
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ApiError, createRouteClient, routes } from "@webflix/contracts";
import { FIXTURE_CATALOG, FIXTURE_MANIFEST } from "@webflix/core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { handleFetch } from "../src/index.ts";
import { getRuntime } from "../src/runtime.ts";

interface Envelope {
  type: string;
  payload: unknown;
}

const queued: Envelope[] = [];
const jobs = {
  async send(body: Envelope) {
    queued.push(body);
  },
  async sendBatch(messages: Array<{ body: Envelope }>) {
    for (const message of messages) queued.push(message.body);
  },
} as unknown as Queue;
const testEnv = { ...env, JOBS: jobs } as typeof env;
const DAY_SEC = 24 * 3600;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await getRuntime(testEnv).services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: null,
    manifest: FIXTURE_MANIFEST,
  });
});

async function drain() {
  const runtime = getRuntime(testEnv);
  for (let message = queued.shift(); message; message = queued.shift()) {
    const outcome = await runtime.services.processor({
      id: crypto.randomUUID(),
      type: message.type,
      payload: message.payload as never,
      attempt: 1,
      enqueuedAt: Date.now(),
    });
    expect(outcome.action).toBe("ack");
  }
}

function client() {
  let cookie = "";
  const origin = getRuntime(testEnv).config.core.publicOrigin;
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("Cookie", cookie);
    const response = await handleFetch(
      new Request(new URL(path, origin), { ...init, headers }),
      testEnv,
      createExecutionContext(),
    );
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(";");
      const [name] = (pair ?? "").split("=");
      if (name && pair) {
        cookie = [
          ...cookie.split("; ").filter((part) => part && !part.startsWith(`${name}=`)),
          pair,
        ].join("; ");
      }
    }
    return response;
  };
  return {
    send,
    api: createRouteClient(routes, {
      baseUrl: origin,
      validateResponses: true,
      fetch: (url: string, init: RequestInit) =>
        send(new URL(url).pathname + new URL(url).search, init),
    }),
    pay: (secret: string | null, card: string) =>
      send("/_pay/form", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: secret ?? "", card }),
      }),
  };
}

async function member(email: string) {
  const c = client();
  await c.api.signup({ body: { email, password: "correct horse battery" } });
  return c;
}

async function withProfile(c: ReturnType<typeof client>) {
  const profile = await c.api.createProfile({ body: { name: "Sam", avatarId: "av-fox" } });
  await c.api.selectProfile({ body: { profileId: profile.id } });
}

describe("billing in the Worker (workerd, D1, fake provider)", () => {
  it("checks out with a trial through the fake's form, activates by the provider's event, and plays", async () => {
    const c = await member("edge-trial@example.test");
    expect(await c.api.getBillingConfig()).toEqual({ provider: "fake", formUrl: "/_pay/form" });
    const started = await c.api.startCheckout({ body: { planId: "premium" } });
    const page = await c.send(`/_pay/form?secret=${started.clientSecret}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect((await c.pay(started.clientSecret, "visa")).status).toBe(200);
    const confirmed = await c.api.confirmCheckout({ params: { id: started.id } });
    expect(confirmed.trial?.days).toBe(7);
    await drain();
    expect((await c.api.getCheckout({ params: { id: started.id } })).status).toBe("complete");
    await withProfile(c);
    const account = await c.api.getAccount();
    expect(account.membership).toMatchObject({
      status: "trialing",
      planId: "premium",
      provider: "fake",
    });
    expect(account.entitlement).toMatchObject({ entitled: true, maxStreams: 4 });
    const playback = await c.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    expect(playback.id).toBeTruthy();
  });

  it("refuses an unsigned webhook and serves no form for unknown /_pay paths", async () => {
    const c = client();
    const forged = await c.send("/api/v1/webhooks/payments/fake", {
      method: "POST",
      headers: { "Stripe-Signature": "t=1,v1=00" },
      body: JSON.stringify({ id: "evt_x", type: "invoice.paid" }),
    });
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { code: string }).code).toBe("webhook_signature_invalid");
    expect((await c.send("/_pay/nope")).status).toBe(404);
  });

  it("renews on the test clock, fails, recovers with a new card, and changes plan as previewed", async () => {
    const c = await member("edge-renewal@example.test");
    const started = await c.api.startCheckout({ body: { planId: "standard" } });
    await c.pay(started.clientSecret, "charge-declined");
    await c.api.confirmCheckout({ params: { id: started.id } });
    await drain();
    await withProfile(c);
    await c.api.advanceBillingClock({ body: { seconds: 7 * DAY_SEC + 7200 } });
    await drain();
    expect((await c.api.getAccount()).membership?.status).toBe("past_due");
    const setup = await c.api.setupPaymentMethod();
    const confirm = await c.send("/_pay/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientSecret: setup.clientSecret, card: "visa" }),
    });
    expect(await confirm.json()).toEqual({ status: "succeeded" });
    await drain();
    const recovered = await c.api.getAccount();
    expect(recovered.membership?.status).toBe("active");
    expect(recovered.paymentMethod?.last4).toBe("4242");
    const preview = await c.api.previewPlanChange({ body: { planId: "premium" } });
    const changed = await c.api.changePlan({
      body: { planId: "premium", previewToken: preview.previewToken },
    });
    expect(changed.plan.id).toBe("premium");
    const invoices = await c.api.listInvoices({ query: {} });
    expect(invoices.items.some((invoice) => invoice.description === "Plan change")).toBe(true);
    const refused = await c.api
      .validatePromotion({ body: { code: "NOPE", planId: "basic" } })
      .catch((error: unknown) => error);
    expect(ApiError.is(refused, "promotion_code_invalid")).toBe(true);
  });
});
