import { PaymentProviderError, utf8Encode, WebhookSignatureError } from "@webflix/core";
import { describe, expect, it } from "vitest";
import { encodeForm, mapStripeError, StripeClient } from "../../src/client.ts";
import { toEvent, toInvoice, toSetup, toSubscription } from "../../src/mapping.ts";
import { StripePaymentProvider } from "../../src/provider.ts";
import { signatureHeader, verifyStripeSignature } from "../../src/webhook.ts";
import { deliveries, events, responses, scenarios } from "./fixtures.ts";

// Assembled at run time so no source file holds anything shaped like a real secret.
const SECRET = ["whsec", "test", "fixture", "secret", "0000"].join("_");

describe("Stripe webhooks: verified over the exact bytes with Web Crypto", () => {
  it("verifies every recorded delivery re-signed with a test secret, and normalises its ids", async () => {
    let checked = 0;
    for (const scenario of scenarios()) {
      for (const delivery of deliveries(scenario)) {
        const body = utf8Encode(JSON.stringify(delivery.event));
        const now = delivery.event.created * 1000 + 1000;
        const header = await signatureHeader(SECRET, body, delivery.event.created);
        const event = await verifyStripeSignature(body, header, SECRET, now);
        expect(event.id).toBe(delivery.event.id);
        expect(event.type).toBe(delivery.event.type);
        expect(event.createdAt).toBe(delivery.event.created * 1000);
        expect(structuredClone(event)).toEqual(event);
        const object = delivery.event.data.object;
        if (object.object === "subscription") expect(event.subscriptionId).toBe(object.id);
        // `invoice.upcoming` carries an invoice that does not exist yet (no id).
        if (object.object === "invoice" && typeof object.id === "string") {
          expect(event.invoiceId).toBe(object.id);
          const parent = object.parent as {
            subscription_details?: { subscription?: string };
          } | null;
          expect(event.subscriptionId).toBe(parent?.subscription_details?.subscription ?? null);
        }
        if (object.object === "setup_intent") expect(event.setupId).toBe(object.id);
        if (object.object === "customer") expect(event.customerId).toBe(object.id);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("refuses a tampered body, another secret, an old or future timestamp, and no signature", async () => {
    const [delivery] = deliveries("renewal-recovers");
    if (!delivery) throw new Error("no fixture");
    const body = utf8Encode(JSON.stringify(delivery.event));
    const t = delivery.event.created;
    const now = t * 1000;
    const good = await signatureHeader(SECRET, body, t);
    await expect(verifyStripeSignature(body, good, SECRET, now)).resolves.toMatchObject({
      id: delivery.event.id,
    });
    const tampered = utf8Encode(JSON.stringify({ ...delivery.event, type: "invoice.paid" }));
    const refusals: [Uint8Array, string | null, number][] = [
      [tampered, good, now],
      [body, await signatureHeader(`${SECRET}x`, body, t), now],
      [body, good, now + 301_000],
      [body, good, now - 301_000],
      [body, null, now],
      [body, `t=${t}`, now],
      [body, `v1=${good.split("v1=")[1]}`, now],
    ];
    for (const [bytes, header, at] of refusals) {
      await expect(verifyStripeSignature(bytes, header, SECRET, at)).rejects.toBeInstanceOf(
        WebhookSignatureError,
      );
    }
    // Several v1 (a secret being rolled) and the sandbox-only v0 are fine.
    const rolled = `t=${t},v1=${"0".repeat(64)},${good.split(",")[1]},v0=${"f".repeat(64)}`;
    await expect(verifyStripeSignature(body, rolled, SECRET, now)).resolves.toBeTruthy();
  });

  it("refuses a validly signed body that is not an event", async () => {
    const body = utf8Encode(JSON.stringify({ hello: "world" }));
    const header = await signatureHeader(SECRET, body, 1_800_000_000);
    await expect(
      verifyStripeSignature(body, header, SECRET, 1_800_000_000_000),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});

describe("Stripe client", () => {
  it("form-encodes nested parameters the way Stripe reads them", () => {
    const form = new URLSearchParams(
      encodeForm({
        customer: "cus_1",
        items: [{ price: "price_1" }],
        payment_settings: { save_default_payment_method: "on_subscription" },
        expand: ["latest_invoice.confirmation_secret", "default_payment_method"],
        lookup_keys: ["a", "b"],
        trial_period_days: 7,
        discounts: undefined,
        cancel_at_period_end: false,
      }),
    );
    expect([...form.entries()]).toEqual([
      ["customer", "cus_1"],
      ["items[0][price]", "price_1"],
      ["payment_settings[save_default_payment_method]", "on_subscription"],
      ["expand[]", "latest_invoice.confirmation_secret"],
      ["expand[]", "default_payment_method"],
      ["lookup_keys[0]", "a"],
      ["lookup_keys[1]", "b"],
      ["trial_period_days", "7"],
      ["cancel_at_period_end", "false"],
    ]);
  });

  it.each([
    [
      402,
      { type: "card_error", code: "card_declined", decline_code: "generic_decline" },
      "card_declined",
    ],
    [
      402,
      { type: "card_error", code: "card_declined", decline_code: "insufficient_funds" },
      "insufficient_funds",
    ],
    [402, { type: "card_error", code: "expired_card" }, "expired_card"],
    [402, { type: "card_error", code: "incorrect_cvc" }, "incorrect_cvc"],
    [
      402,
      { type: "invalid_request_error", code: "invoice_payment_intent_requires_action" },
      "authentication_required",
    ],
    [400, { type: "idempotency_error" }, "idempotency_conflict"],
    [404, { type: "invalid_request_error", code: "resource_missing" }, "not_found"],
    [429, { type: "invalid_request_error", code: "rate_limit" }, "rate_limited"],
    [500, { type: "api_error" }, "unavailable"],
    [400, { type: "invalid_request_error", code: null }, "invalid_request"],
  ])("maps HTTP %i %j to %s (never the message)", (status, error, code) => {
    expect(mapStripeError(status, error)).toBe(code);
  });

  it("sends the caller's idempotency key and the pinned version, and retries with the same key", async () => {
    const seen: { key: string | null; version: string | null; body: string }[] = [];
    let calls = 0;
    const client = new StripeClient({
      secretKey: "rk_test_x",
      sleep: async () => {},
      fetch: async (_input, init) => {
        calls += 1;
        const headers = new Headers(init?.headers);
        seen.push({
          key: headers.get("Idempotency-Key"),
          version: headers.get("Stripe-Version"),
          body: String(init?.body ?? ""),
        });
        if (calls === 1) throw new TypeError("network down");
        if (calls === 2) {
          return new Response(
            JSON.stringify({
              error: { type: "invalid_request_error", code: "idempotency_key_in_use" },
            }),
            { status: 409 },
          );
        }
        return new Response(JSON.stringify({ id: "cus_1", object: "customer" }), { status: 200 });
      },
    });
    const customer = await client.post(
      "/v1/customers",
      { email: "a@example.test" },
      "webflix-op-1",
    );
    expect(customer.id).toBe("cus_1");
    expect(seen.map((call) => call.key)).toEqual(["webflix-op-1", "webflix-op-1", "webflix-op-1"]);
    expect(new Set(seen.map((call) => call.version))).toEqual(new Set(["2026-11-18.endive"]));
  });

  it("turns a decline into the port's error, and an answer of 404 into null for reads", async () => {
    const provider = new StripePaymentProvider({
      secretKey: "rk_test_x",
      webhookSecret: SECRET,
      sleep: async () => {},
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/v1/subscriptions/")) {
          return new Response(
            JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing" } }),
            { status: 404 },
          );
        }
        return new Response(
          JSON.stringify({
            error: {
              type: "card_error",
              code: "card_declined",
              decline_code: "insufficient_funds",
              message:
                "[req_x] Your card has insufficient funds. (This is an unclaimed Stripe sandbox.)",
            },
          }),
          { status: 402 },
        );
      },
    });
    expect(await provider.retrieveSubscription("sub_missing")).toBeNull();
    const error = await provider
      .createCustomer({ accountId: "a", email: "a@example.test" }, { idempotencyKey: "k" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect((error as PaymentProviderError).code).toBe("insufficient_funds");
    expect((error as Error).message).not.toContain("sandbox");
  });
});

describe("Stripe objects → the port's shapes (recorded responses)", () => {
  it("maps every recorded subscription, invoice and setup without losing what the projection needs", () => {
    let subscriptionsSeen = 0;
    let invoicesSeen = 0;
    let setupsSeen = 0;
    for (const scenario of scenarios()) {
      for (const event of events(scenario)) {
        const object = event.data.object;
        if (object.object === "subscription") {
          const mapped = toSubscription(object, null);
          expect(mapped.id).toBe(object.id);
          expect(mapped.customerId).toMatch(/^cus_/);
          expect(mapped.priceLookupKey).toMatch(/^webflix\.[a-z]+\.monthly\.(usd|eur)$/);
          expect(mapped.currentPeriodEnd).toBeGreaterThan(0);
          expect(structuredClone(mapped)).toEqual(mapped);
          subscriptionsSeen += 1;
        }
        if (object.object === "invoice" && event.type !== "invoice.upcoming") {
          const mapped = toInvoice(object, 0);
          expect(mapped.id).toBe(object.id);
          expect(["draft", "open", "paid", "void", "uncollectible"]).toContain(mapped.status);
          expect(mapped.currency).toMatch(/^[A-Z]{3}$/);
          invoicesSeen += 1;
        }
        if (object.object === "setup_intent") {
          const mapped = toSetup(object);
          expect(["requires_confirmation", "processing", "succeeded", "failed"]).toContain(
            mapped.status,
          );
          setupsSeen += 1;
        }
      }
    }
    expect(subscriptionsSeen).toBeGreaterThan(30);
    expect(invoicesSeen).toBeGreaterThan(50);
    expect(setupsSeen).toBeGreaterThan(5);
  });

  it("maps the recorded declined charge on renewal and the action required off-session", () => {
    const failed = events("renewal-recovers").find(
      (event) => event.type === "invoice.payment_failed",
    );
    expect(failed).toBeDefined();
    const invoice = toInvoice(failed?.data.object ?? {}, 0);
    expect(invoice).toMatchObject({
      status: "open",
      billingReason: "subscription_cycle",
      attemptCount: 1,
    });
    expect(invoice.nextPaymentAttempt).toBeGreaterThan(invoice.createdAt);
    const action = events("three-d-secure").filter(
      (event) => event.type === "invoice.payment_action_required",
    );
    const offSession = action
      .map((event) => toInvoice(event.data.object, 0))
      .find((mapped) => mapped.billingReason === "subscription_cycle");
    // Stripe does not retry a renewal that needs authentication (docs/STRIPE.md §8).
    expect(offSession?.nextPaymentAttempt).toBeNull();
    const recorded = responses("three-d-secure").find((response) =>
      String(response.label).includes("requires_action"),
    );
    if (recorded) expect(recorded.body).toBeTruthy();
  });

  it("normalises an event's ids and nothing else (no state is carried)", () => {
    const [event] = events("trial-converts");
    const normalised = toEvent(event);
    expect(Object.keys(normalised ?? {}).sort()).toEqual([
      "createdAt",
      "customerId",
      "id",
      "idempotencyKey",
      "invoiceId",
      "occurredAt",
      "setupId",
      "subscriptionId",
      "type",
    ]);
  });
});
