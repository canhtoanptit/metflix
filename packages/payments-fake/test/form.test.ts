import { billingIdempotencyKey } from "@webflix/core";
import { describe, expect, it } from "vitest";
import { createFakePaymentForm } from "../src/form.ts";
import { FakePaymentProvider } from "../src/provider.ts";
import { MemoryFakeStore } from "../src/store.ts";
import { TEST_PRICES, TEST_WEBHOOK_SECRET } from "./harness.ts";

const ORIGIN = "http://localhost:5670";
const key = () => ({ idempotencyKey: billingIdempotencyKey(crypto.randomUUID(), 1) });

async function setup() {
  const fake = new FakePaymentProvider({
    store: new MemoryFakeStore(),
    webhookSecret: TEST_WEBHOOK_SECRET,
  });
  await fake.syncCatalogue([TEST_PRICES.basic]);
  const handle = createFakePaymentForm({ provider: fake });
  const request = async (path: string, init?: RequestInit) => {
    const response = await handle(new Request(`${ORIGIN}${path}`, init));
    if (!response) throw new Error(`not handled: ${path}`);
    return response;
  };
  const post = (path: string, fields: Record<string, string>) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  const customer = await fake.createCustomer({ accountId: "a", email: "a@example.test" }, key());
  const created = await fake.createSetup({ customerId: customer.id }, key());
  return { fake, handle, request, post, customerId: customer.id, setup: created };
}

describe("fake provider: the payment form (/_pay)", () => {
  it("leaves every other path to the app", async () => {
    const { handle } = await setup();
    expect(await handle(new Request(`${ORIGIN}/api/v1/plans`))).toBeNull();
    expect(await handle(new Request(`${ORIGIN}/_payment`))).toBeNull();
  });

  it("shows the form with its own restrictive headers and no card data in the page", async () => {
    const { request, setup: created } = await setup();
    const response = await request(
      `/_pay/form?secret=${created.clientSecret}&return=/signup/payment`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("Add a card");
    expect(html).toContain('action="/_pay/form"');
  });

  it("confirms a card and sends the browser back to a same-origin path only", async () => {
    const { fake, post, setup: created } = await setup();
    const response = await post("/_pay/form", {
      secret: created.clientSecret ?? "",
      card: "visa",
      return: "/signup/payment?step=2",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/signup/payment?step=2&payment=succeeded");
    expect((await fake.retrieveSetup(created.id))?.status).toBe("succeeded");

    for (const hostile of ["https://evil.example/", "//evil.example/", "/\\evil", "javascript:x"]) {
      const another = await fake.createSetup({ customerId: created.customerId }, key());
      const answer = await post("/_pay/form", {
        secret: another.clientSecret ?? "",
        card: "visa",
        return: hostile,
      });
      expect(answer.status).toBe(200);
      expect(answer.headers.get("Location")).toBeNull();
    }
  });

  it("runs the challenge page for a card that asks for one", async () => {
    const { fake, post, request, setup: created } = await setup();
    const first = await post("/_pay/form", {
      secret: created.clientSecret ?? "",
      number: "4000 0025 0000 3155",
      return: "/account",
    });
    expect(first.status).toBe(303);
    const challenge = first.headers.get("Location") ?? "";
    expect(challenge).toMatch(/^\/_pay\/challenge\?/);
    expect((await request(challenge)).status).toBe(200);
    const done = await post("/_pay/challenge", {
      secret: created.clientSecret ?? "",
      outcome: "complete",
      return: "/account",
    });
    expect(done.headers.get("Location")).toBe("/account?payment=succeeded");
    expect((await fake.retrieveSetup(created.id))?.paymentMethod?.last4).toBe("3155");
  });

  it("refuses a number that is not a test card, and shows declines without a provider message", async () => {
    const { post, setup: created } = await setup();
    const real = await post("/_pay/form", {
      secret: created.clientSecret ?? "",
      number: "4111 1111 1111 1111",
    });
    expect(real.status).toBe(422);
    const declined = await post("/_pay/form", {
      secret: created.clientSecret ?? "",
      card: "insufficient-funds",
    });
    expect(declined.status).toBe(402);
    expect(await declined.text()).toContain("insufficient funds");
  });

  it("serves the same as JSON for suites, and refuses JSON control calls sent as forms", async () => {
    const { request, setup: created } = await setup();
    const confirmed = await request("/_pay/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientSecret: created.clientSecret, card: "mastercard" }),
    });
    expect(await confirmed.json()).toEqual({ status: "succeeded" });
    const forged = await request("/_pay/api/delivery", {
      method: "PUT",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "mode=outage",
    });
    expect(forged.status).toBe(415);
    const set = await request("/_pay/api/delivery", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "unruly", duplicateRate: 0.3, maxDelayMs: 100 }),
    });
    expect(await set.json()).toEqual({ mode: "unruly", duplicateRate: 0.3, maxDelayMs: 100 });
    expect(await (await request("/_pay/api/delivery")).json()).toMatchObject({ mode: "unruly" });
  });

  it("pays a first invoice with the card on file", async () => {
    const { fake, post, request, customerId, setup: created } = await setup();
    await fake.confirmSetup(created.clientSecret ?? "", "visa");
    const card = (await fake.retrieveSetup(created.id))?.paymentMethod?.id ?? null;
    const subscription = await fake.createSubscription(
      {
        customerId,
        priceLookupKey: TEST_PRICES.basic.lookupKey,
        paymentMethodId: card,
        trialDays: null,
        promotionId: null,
      },
      key(),
    );
    const secret = subscription.paymentClientSecret ?? "";
    const form = await (await request(`/_pay/form?secret=${secret}`)).text();
    expect(form).toContain("Pay 7.99 USD");
    expect(form).toContain("ending 4242");
    const paid = await post("/_pay/form", { secret, card: "" });
    expect(paid.status).toBe(200);
    expect((await fake.retrieveSubscription(subscription.id))?.status).toBe("active");
  });
});
