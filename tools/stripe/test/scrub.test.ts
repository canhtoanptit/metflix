import { describe, expect, it } from "vitest";
import { Scrubber } from "../src/scrub.ts";
import { findSecrets } from "../src/secrets.ts";
import { fake } from "./fakes.ts";

function sample() {
  return {
    id: "evt_1AbQr77xQm2LpRt9aBcDeFgH",
    account: "acct_1AbCDE7xQm2LpRt9",
    request: { id: "req_Hc5Kd8Ws2Ye1Pu", idempotency_key: "stripe-node-retry-1b4f" },
    data: {
      object: {
        id: "in_1AbQr77xQm2LpRt91a2B3c4D",
        object: "invoice",
        customer: "cus_Zq81Lm4NpQ2rTx",
        customer_email: "trial-converts-member@example.test",
        billing_reason: "subscription_cycle",
        collection_method: "charge_automatically",
        hosted_invoice_url:
          "https://invoice.stripe.com/i/acct_1AbCDE7xQm2LpRt9/test_YWNjdF8xVWVIWUQ0a1Nm?s=ap",
        confirmation_secret: { client_secret: fake.piClientSecret, type: "payment_intent" },
        parent: { subscription_details: { subscription: "sub_1AbQr77xQm2LpRt9zzYyXx" } },
        lines: { url: "/v1/invoices/in_1AbQr77xQm2LpRt91a2B3c4D/lines" },
        payment_method_details: { card: { fingerprint: "Gz3NNQhX3OYn5mPU", last4: "4242" } },
        mandate: {
          customer_acceptance: { online: { ip_address: "203.0.113.7", user_agent: "Mozilla/5.0" } },
        },
        note: `key ${fake.sandboxKey} and ${fake.webhookSecret} and ${fake.claimUrl}`,
        error: `The provided key '${fake.maskedKey}' does not have the required permissions`,
      },
    },
  };
}

describe("Scrubber", () => {
  it("leaves nothing secret-shaped behind", () => {
    const text = JSON.stringify(new Scrubber().scrub(sample()));
    expect(findSecrets(text)).toEqual([]);
    for (const value of [
      fake.sandboxKey,
      fake.webhookSecret,
      fake.claimUrl,
      "203.0.113.7",
      "YWNjdF8x",
      "trial-converts-member@example.test",
    ]) {
      expect(text).not.toContain(value);
    }
  });

  it("rewrites ids consistently and keeps their prefix and a realistic shape", () => {
    const out = new Scrubber().scrub(sample()) as ReturnType<typeof sample>;
    const invoice = out.data.object;
    expect(invoice.id).toMatch(/^in_WFX[0-9A-Za-z]{10,}$/);
    expect(invoice.lines.url).toBe(`/v1/invoices/${invoice.id}/lines`);
    expect(out.account).toMatch(/^acct_WFX/);
    expect(invoice.customer).toMatch(/^cus_WFX/);
    expect(invoice.parent.subscription_details.subscription).toMatch(/^sub_WFX/);
    expect(out.request.id).toMatch(/^req_WFX/);
  });

  it("rewrites ids with compound prefixes (preview invoices and their lines)", () => {
    const out = new Scrubber().scrub({
      id: "upcoming_in_1AbQr77xQm2LpRt9LRKhrOGh",
      lines: [
        { id: "il_tmp_1AbQr77xQm2LpRt9zz2mI2q1", invoice: "upcoming_in_1AbQr77xQm2LpRt9LRKhrOGh" },
      ],
      schedule: "sub_sched_1AbQr77xQm2LpRt9AbCdEf",
      reason: "pending_if_incomplete",
    }) as {
      id: string;
      lines: Array<{ id: string; invoice: string }>;
      schedule: string;
      reason: string;
    };
    expect(out.id).toMatch(/^upcoming_in_WFX/);
    expect(out.lines[0]?.id).toMatch(/^il_tmp_WFX/);
    expect(out.lines[0]?.invoice).toBe(out.id);
    expect(out.schedule).toMatch(/^sub_sched_WFX/);
    expect(out.reason).toBe("pending_if_incomplete");
    expect(JSON.stringify(out)).not.toContain("7xQm2LpRt9");
  });

  it("keeps the intent id of a client secret (rewritten) and drops the secret", () => {
    const out = new Scrubber().scrub(sample()) as ReturnType<typeof sample>;
    expect(out.data.object.confirmation_secret.client_secret).toMatch(
      /^pi_WFX[0-9A-Za-z]+_secret_\[redacted\]$/,
    );
  });

  it("is deterministic: same input, same output", () => {
    expect(new Scrubber().scrub(sample())).toEqual(new Scrubber().scrub(sample()));
  });

  it("is idempotent: scrubbing scrubbed data changes nothing", () => {
    const once = new Scrubber().scrub(sample());
    expect(new Scrubber().scrub(once)).toEqual(once);
  });

  it("maps one value to one replacement across documents", () => {
    const scrubber = new Scrubber();
    const a = scrubber.scrub({ customer: "cus_Zq81Lm4NpQ2rTx", email: "a@x.example" }) as Record<
      string,
      string
    >;
    const b = scrubber.scrub({
      id: "cus_Zq81Lm4NpQ2rTx",
      receipt_email: "a@x.example",
      other: "b@x.example",
    }) as Record<string, string>;
    expect(b.id).toBe(a.customer);
    expect(b.receipt_email).toBe(a.email);
    expect(b.other).not.toBe(a.email);
    expect(a.email).toMatch(/^member-\d+@example\.test$/);
  });

  it("preserves equality, and inequality, of card fingerprints", () => {
    const scrubber = new Scrubber();
    const out = scrubber.scrub([
      { fingerprint: "Gz3NNQhX3OYn5mPU" },
      { fingerprint: "Gz3NNQhX3OYn5mPU" },
      { fingerprint: "Hq9PPRiY4PZo6nQV" },
    ]) as Array<{ fingerprint: string }>;
    expect(out[0]?.fingerprint).toBe(out[1]?.fingerprint);
    expect(out[2]?.fingerprint).not.toBe(out[0]?.fingerprint);
    expect(out[0]?.fingerprint).not.toBe("Gz3NNQhX3OYn5mPU");
  });

  it("leaves API enum values, event types, custom ids and lookup keys untouched", () => {
    const values = {
      proration_behavior: "create_prorations",
      collection_method: "charge_automatically",
      status: "requires_payment_method",
      type: "customer.subscription.trial_will_end",
      product: "webflix_basic",
      lookup_key: "webflix.basic.monthly.usd",
      payment_method: "pm_card_visa",
      last4: "4242",
    };
    expect(new Scrubber().scrub(values)).toEqual(values);
  });

  it("keeps the host of Stripe-hosted URLs and drops the capability path", () => {
    const out = new Scrubber().scrub(sample()) as ReturnType<typeof sample>;
    expect(out.data.object.hosted_invoice_url).toBe("https://invoice.stripe.com/[redacted]");
  });
});
