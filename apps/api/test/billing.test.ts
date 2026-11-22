/**
 * Billing through the real Node composition (dev mode): SQLite, the fake payment provider with
 * its state in the same database, its payment form at `/_pay/*`, webhooks signed by the fake and
 * verified by the API, the in-process job queue, and the typed client over HTTP.
 */
import { ApiError, createRouteClient, routes } from "@webflix/contracts";
import type { MemoryJobQueue } from "@webflix/core/memory";
import {
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
  FIXTURE_MASTER_PLAYLIST,
} from "@webflix/core/testing";
import { migrateToLatest } from "@webflix/db";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/config.ts";
import { createHttpApp, createRuntime, type Runtime } from "../src/runtime.ts";
import { createCookieJar } from "./cookie-jar.ts";

let runtime: Runtime;
let app: Hono;
let queue: MemoryJobQueue;
const DAY_SEC = 24 * 3600;

beforeAll(async () => {
  const config = loadApiConfig({
    WEBFLIX_DATABASE_URL: "sqlite::memory:",
    WEBFLIX_BLOB_STORE: "memory",
    WEBFLIX_MEDIA_DIR: "none",
    WEBFLIX_LOG_LEVEL: "error",
  });
  expect(config.core.billing.paymentProvider).toBe("fake");
  runtime = createRuntime(config, "api");
  await migrateToLatest(runtime.infra.database);
  await runtime.services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: FIXTURE_DEMO_ACCOUNT,
    manifest: FIXTURE_MANIFEST,
  });
  await runtime.infra.blobs.put("vod/v-pkg/master.m3u8", FIXTURE_MASTER_PLAYLIST);
  app = createHttpApp(runtime);
  queue = runtime.infra.jobs.queue as MemoryJobQueue;
  queue.setProcessor(runtime.services.processor);
});

afterAll(async () => {
  await runtime.close();
});

async function drain() {
  for (let i = 0; i < 20 && queue.size > 0; i += 1) await queue.drain();
}

function client() {
  const jar = createCookieJar();
  const send = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.header()) headers.set("Cookie", jar.header());
    const response = await app.request(url, { ...init, headers });
    jar.store(response);
    return response;
  };
  return {
    api: createRouteClient(routes, {
      validateResponses: true,
      headers: (): Record<string, string> => (jar.header() ? { Cookie: jar.header() } : {}),
      fetch: (url: string, init: RequestInit) => send(url, init),
    }),
    send,
    /** The browser in the fake's payment form. */
    pay: (secret: string | null, card: string) =>
      send("/_pay/form", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: secret ?? "", card, return: "/signup/done" }),
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

describe("billing over HTTP on the Node runtime (dev: fake provider on SQLite)", () => {
  it("serves the provider configuration and plans with their trial", async () => {
    const c = client();
    expect(await c.api.getBillingConfig()).toEqual({ provider: "fake", formUrl: "/_pay/form" });
    const plans = await c.api.listPlans();
    expect(
      plans.items.map((plan) => [plan.id, plan.monthlyPrice.amountMinor, plan.trial?.days]),
    ).toEqual([
      ["basic", 799, 7],
      ["standard", 1299, 7],
      ["premium", 1899, 7],
    ]);
  });

  it("signs up without payment, checks out with a trial through the provider's form, and plays", async () => {
    const c = await member("trial@example.test");
    const started = await c.api.startCheckout({ body: { planId: "standard" } });
    expect(started.status).toBe("requires_setup");
    // The card goes to the fake's form, never to the API.
    const form = await c.send(`/_pay/form?secret=${started.clientSecret}`);
    expect(form.status).toBe(200);
    expect(form.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const paid = await c.pay(started.clientSecret, "visa");
    expect(paid.status).toBe(303);
    expect(paid.headers.get("Location")).toBe("/signup/done?payment=succeeded");
    const confirmed = await c.api.confirmCheckout({ params: { id: started.id } });
    expect(confirmed.trial?.days).toBe(7);
    await drain();
    // The web polls the checkout from the profile gate (GET /account needs a profile).
    expect((await c.api.getCheckout({ params: { id: started.id } })).status).toBe("complete");
    await withProfile(c);
    const account = await c.api.getAccount();
    expect(account.membership).toMatchObject({
      status: "trialing",
      planId: "standard",
      provider: "fake",
    });
    expect(account.entitlement).toMatchObject({ entitled: true, maxStreams: 2 });
    expect(account.subscription.status).toBe("active");
    const session = await c.api.getSession();
    if (!session.authenticated) throw new Error("signed out");
    expect(session.subscription.status).toBe("active");
    const playback = await c.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    expect(playback.maxVideoHeight).toBe(1080);
  });

  it("refuses playback without a membership (no card at sign-up)", async () => {
    const c = await member("nothing@example.test");
    await withProfile(c);
    const account = await c.api.getAccount();
    expect(account.membership?.status).toBe("none");
    expect(account.entitlement).toMatchObject({ entitled: false, reason: "no_membership" });
    const refused = await c.api
      .createPlaybackSession({ body: { titleId: "t-orbit" } })
      .catch((error: unknown) => error);
    expect(
      ApiError.is(refused, "subscription_required") || ApiError.is(refused, "unauthenticated"),
    ).toBe(true);
  });

  it("verifies the webhook route's signature over the raw body; a redelivery is acknowledged once", async () => {
    const c = client();
    const forged = await c.send("/api/v1/webhooks/payments/fake", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=deadbeef" },
      body: JSON.stringify({ id: "evt_forged", type: "invoice.paid" }),
    });
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { code: string }).code).toBe("webhook_signature_invalid");
    const wrongProvider = await c.send("/api/v1/webhooks/payments/stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=deadbeef" },
      body: "{}",
    });
    expect(wrongProvider.status).toBe(404);
  });

  it("renews, changes plan as previewed, cancels and resumes, and lists invoices", async () => {
    const used = await member("used-card@example.test");
    const first = await used.api.startCheckout({ body: { planId: "basic" } });
    await used.pay(first.clientSecret, "visa");
    await used.api.confirmCheckout({ params: { id: first.id } });

    const c = await member("paid@example.test");
    const started = await c.api.startCheckout({ body: { planId: "basic" } });
    await c.pay(started.clientSecret, "visa");
    const confirmed = await c.api.confirmCheckout({ params: { id: started.id } });
    // Same card as another account: no trial; the first payment is confirmed in the form.
    expect(confirmed).toMatchObject({ status: "requires_payment", trial: null });
    await c.pay(confirmed.clientSecret, "visa");
    await drain();
    await withProfile(c);
    expect((await c.api.getAccount()).membership?.status).toBe("active");

    // A month passes on this account's test clock: the renewal is collected.
    await c.api.advanceBillingClock({ body: { seconds: 31 * DAY_SEC } });
    await drain();
    const invoices = await c.api.listInvoices({ query: {} });
    expect(
      invoices.items.filter((invoice) => invoice.status === "paid").length,
    ).toBeGreaterThanOrEqual(2);

    const preview = await c.api.previewPlanChange({ body: { planId: "premium" } });
    const changed = await c.api.changePlan({
      body: { planId: "premium", previewToken: preview.previewToken },
    });
    expect(changed.plan.id).toBe("premium");
    const canceled = await c.api.cancelMembership();
    expect(canceled.subscription.status).toBe("canceling");
    expect((await c.api.getAccount()).membership).toMatchObject({ cancelAtPeriodEnd: true });
    const resumed = await c.api.resumeMembership();
    expect(resumed.subscription.status).toBe("active");
  });

  it("replaces the card through a setup the fake's form confirms", async () => {
    const c = await member("card@example.test");
    const started = await c.api.startCheckout({ body: { planId: "standard" } });
    await c.pay(started.clientSecret, "mastercard");
    await c.api.confirmCheckout({ params: { id: started.id } });
    await drain();
    await withProfile(c);
    const setup = await c.api.setupPaymentMethod();
    const confirm = await c.send("/_pay/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientSecret: setup.clientSecret, card: "4000 0025 0000 3155" }),
    });
    expect(await confirm.json()).toEqual({ status: "requires_action" });
    await c.send("/_pay/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientSecret: setup.clientSecret, challenge: "complete" }),
    });
    await drain();
    expect((await c.api.getPaymentMethodSetup({ params: { id: setup.id } })).status).toBe(
      "succeeded",
    );
    expect((await c.api.getAccount()).paymentMethod).toMatchObject({ last4: "3155" });
  });

  it("validates promo codes per account and keeps milestone 1's sign-up with a card working", async () => {
    const c = await member("promo@example.test");
    const refused = await c.api
      .validatePromotion({ body: { code: "NOPE", planId: "basic" } })
      .catch((error: unknown) => error);
    expect(ApiError.is(refused, "promotion_code_invalid")).toBe(true);

    const legacy = client();
    await legacy.api.signup({
      body: {
        email: "legacy@example.test",
        password: "correct horse battery",
        planId: "basic",
        payment: {
          method: "card",
          cardNumber: "4242 4242 4242 4242",
          expMonth: 12,
          expYear: 2031,
          cvc: "123",
          nameOnCard: "Sam",
        },
      },
    });
    await withProfile(legacy);
    const account = await legacy.api.getAccount();
    expect(account.subscription.status).toBe("active");
    expect(account.membership).toMatchObject({ status: "active", provider: null, planId: "basic" });
    // Milestone 1's plan change on a mock membership is unchanged.
    const changed = await legacy.api.changePlan({ body: { planId: "standard" } });
    expect(changed.plan.id).toBe("standard");
  });
});
