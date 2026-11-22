import type { CatalogueEntry, PaymentTestCard, ProviderSubscription } from "@webflix/core";
import type { PaymentProviderHarness } from "@webflix/core/testing";
import { STRIPE_API_VERSION } from "../../src/client.ts";
import { StripePaymentProvider } from "../../src/provider.ts";
import { signatureHeader } from "../../src/webhook.ts";

/**
 * The real Stripe sandbox (docs/STRIPE.md), portable (Node and workerd): keys are handed in by
 * the runner from its environment (`.cache/stripe/stripe.env`, written by `make stripe-sandbox`)
 * and are never printed.
 */
export interface SandboxKeys {
  secretKey: string;
  publishableKey: string;
}

export function sandboxAvailable(keys: SandboxKeys): boolean {
  return keys.secretKey !== "" && /^pk_test_/.test(keys.publishableKey);
}

/**
 * Whether the sandbox answers right now. A claimable sandbox key has a low, undocumented rate
 * limit (docs/STRIPE.md §13): when it is exhausted the lane skips with that reason, never passes.
 */
export async function sandboxReachable(keys: SandboxKeys): Promise<string | null> {
  if (!sandboxAvailable(keys)) return SKIP_REASON;
  try {
    const response = await fetch("https://api.stripe.com/v1/customers?limit=1", {
      headers: { Authorization: `Bearer ${keys.secretKey}` },
    });
    if (response.status === 429) {
      return "the Stripe sandbox refuses requests (429: the claimable sandbox key's rate limit)";
    }
    if (response.status === 401) return "the Stripe sandbox key is no longer valid (expired?)";
    return null;
  } catch {
    return "Stripe could not be reached from here";
  }
}

export const SKIP_REASON =
  "no Stripe sandbox key in the environment (run `make stripe-sandbox`, then load .cache/stripe/stripe.env)";

/** Stripe's test payment methods for the port's test cards (docs/STRIPE.md §6). */
export const TEST_PAYMENT_METHODS: Record<PaymentTestCard, string> = {
  visa: "pm_card_visa",
  mastercard: "pm_card_mastercard",
  declined: "pm_card_visa_chargeDeclined",
  "charge-declined": "pm_card_chargeCustomerFail",
  "authentication-required": "pm_card_authenticationRequired",
};

/** The catalogue as Webflix syncs it (milestone 1's prices, USD). */
export const SANDBOX_PRICES: { basic: CatalogueEntry; premium: CatalogueEntry } = {
  basic: {
    lookupKey: "webflix.basic.monthly.usd",
    productId: "webflix_basic",
    productName: "Webflix Basic",
    amountMinor: 799,
    currency: "USD",
  },
  premium: {
    lookupKey: "webflix.premium.monthly.usd",
    productId: "webflix_premium",
    productName: "Webflix Premium",
    amountMinor: 1899,
    currency: "USD",
  },
};

/** Assembled at run time: the harness signs its own deliveries with it. */
export const TEST_WEBHOOK_SECRET = ["whsec", "sandbox", "harness", "0000"].join("_");

/**
 * What the browser does with the Payment Element: the publishable key and the intent's client
 * secret, never the secret key (raw card numbers are refused on this surface, docs/STRIPE.md
 * §6), with a test PaymentMethod.
 */
export async function browserConfirm(
  keys: SandboxKeys,
  kind: "setup_intents" | "payment_intents",
  clientSecret: string,
  paymentMethod: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const intentId = clientSecret.split("_secret_")[0] ?? "";
  const response = await fetch(`https://api.stripe.com/v1/${kind}/${intentId}/confirm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${keys.publishableKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION,
    },
    body: new URLSearchParams({
      client_secret: clientSecret,
      payment_method: paymentMethod,
      return_url: "http://localhost:5670/return",
    }).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A raw secret-key call for test set-up (coupons, cleanup), outside the adapter. */
export async function stripeApi(
  keys: SandboxKeys,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params).toString();
  const response = await fetch(
    `https://api.stripe.com${path}${method === "GET" && body ? `?${body}` : ""}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${keys.secretKey}`,
        "Stripe-Version": STRIPE_API_VERSION,
        ...(method === "POST"
          ? {
              "Content-Type": "application/x-www-form-urlencoded",
              "Idempotency-Key": `webflix-test-${crypto.randomUUID()}`,
            }
          : {}),
      },
      ...(method === "POST" ? { body } : {}),
    },
  );
  return (await response.json()) as Record<string, unknown>;
}

/** The contract suite's harness on the sandbox; it cancels what each test subscribed. */
export async function sandboxHarness(keys: SandboxKeys): Promise<PaymentProviderHarness> {
  const subscriptions = new Set<string>();
  const real = new StripePaymentProvider({
    secretKey: keys.secretKey,
    webhookSecret: TEST_WEBHOOK_SECRET,
  });
  const provider: StripePaymentProvider = Object.create(real);
  provider.createSubscription = async (input, call) => {
    const created = await real.createSubscription(input, call);
    subscriptions.add(created.id);
    return created;
  };
  await provider.syncCatalogue([SANDBOX_PRICES.basic, SANDBOX_PRICES.premium]);
  return {
    provider,
    prices: SANDBOX_PRICES,
    now: () => Date.now(),
    async confirmSetup(setup, card) {
      await browserConfirm(
        keys,
        "setup_intents",
        setup.clientSecret ?? "",
        TEST_PAYMENT_METHODS[card],
      );
    },
    async confirmPayment(subscription: ProviderSubscription, card) {
      await browserConfirm(
        keys,
        "payment_intents",
        subscription.paymentClientSecret ?? "",
        TEST_PAYMENT_METHODS[card],
      );
    },
    async createPromotion(input) {
      const coupon = await stripeApi(keys, "POST", "/v1/coupons", {
        percent_off: String(input.percentOff),
        duration: "once",
      });
      await stripeApi(keys, "POST", "/v1/promotion_codes", {
        "promotion[type]": "coupon",
        "promotion[coupon]": String(coupon.id),
        code: input.code,
        ...(input.maxRedemptions ? { max_redemptions: String(input.maxRedemptions) } : {}),
      });
    },
    async webhook(options = {}) {
      const page = await stripeApi(keys, "GET", "/v1/events", { limit: "1" });
      const raw = (page.data as Record<string, unknown>[] | undefined)?.[0];
      if (!raw) throw new Error("the sandbox has no event to sign");
      const body = new TextEncoder().encode(JSON.stringify(raw));
      const t = Math.floor(Date.now() / 1000) - (options.ageSec ?? 0);
      return {
        body,
        signature: await signatureHeader(TEST_WEBHOOK_SECRET, body, t),
        id: String(raw.id),
      };
    },
    async cleanup() {
      for (const id of subscriptions) {
        const current = await stripeApi(keys, "GET", `/v1/subscriptions/${id}`);
        if (current.status !== "canceled" && current.status !== "incomplete_expired") {
          await stripeApi(keys, "DELETE", `/v1/subscriptions/${id}`);
        }
      }
    },
  };
}
