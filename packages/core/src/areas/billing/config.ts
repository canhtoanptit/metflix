import {
  type AreaConfigInput,
  type AreaConfigResult,
  choice,
  positiveInteger,
  secret,
} from "../config.ts";

/** `memory` is the in-process reference; `fake` (packages/payments-fake) and `stripe`. */
export const PAYMENT_PROVIDER_ADAPTERS = ["memory", "fake", "stripe"] as const;
export const FAKE_DELIVERY_MODES = ["orderly", "unruly", "outage"] as const;
export const FAKE_RETRIES_EXHAUSTED = ["cancel", "unpaid"] as const;

/** Development only: the fake provider's webhook signing secret when none is configured. */
export const DEV_FAKE_WEBHOOK_SECRET = "whsec_webflix_fake_development_only_0001";

/** Portable billing settings (milestone 2 §5). Owned by the billing area. */
export interface BillingAreaConfig {
  paymentProvider: (typeof PAYMENT_PROVIDER_ADAPTERS)[number];
  /** How long `past_due` stays entitled before `suspended`, from the first failed renewal. */
  graceSec: number;
  /**
   * Stripe credentials (the names `tools/stripe` writes to `.cache/stripe/stripe.env`). Required
   * when the provider is `stripe`; never logged.
   */
  stripe: { secretKey: string; publishableKey: string; webhookSecret: string } | null;
  /** The fake provider (never in production). */
  fake: {
    /** Signs its webhooks; every replica or isolate must share it. */
    webhookSecret: string;
    /** How its webhooks are delivered at start (changeable at run time through `/_pay`). */
    delivery: (typeof FAKE_DELIVERY_MODES)[number];
    /** What happens when every retry of a renewal failed (Stripe's dunning setting, §5.2). */
    retriesExhausted: (typeof FAKE_RETRIES_EXHAUSTED)[number];
    /** Standing promo codes (never expiring, never exhausted, every plan). */
    promotions: { code: string; percentOff?: number; amountOffMinor?: number }[];
  };
}

/** The fake's standing promo code by default: 50% off any plan, unlimited (finding M2-F1). */
export const DEFAULT_FAKE_PROMOTIONS = "WEBFLIX50:50%";

/** `CODE:50%` (a percentage) or `CODE:500` (minor units, USD), comma-separated; `none`. */
export function parseFakePromotions(
  value: string,
  issues: string[],
): BillingAreaConfig["fake"]["promotions"] {
  if (value.trim() === "none") return [];
  const promotions: BillingAreaConfig["fake"]["promotions"] = [];
  for (const entry of value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const match = /^([A-Za-z0-9_-]{1,64}):(\d+)(%?)$/.exec(entry);
    const amount = Number(match?.[2]);
    if (!match?.[1] || !Number.isInteger(amount) || amount <= 0 || (match[3] && amount > 100)) {
      issues.push(
        `WEBFLIX_PAYMENTS_FAKE_PROMOTIONS: "${entry}" is not CODE:<1-100>% or CODE:<amount in minor units>`,
      );
      continue;
    }
    promotions.push(
      match[3]
        ? { code: match[1], percentOff: amount }
        : { code: match[1], amountOffMinor: amount },
    );
  }
  return promotions;
}

/**
 * Variables: WEBFLIX_PAYMENT_PROVIDER (default `fake` outside production, `memory` in
 * production), WEBFLIX_BILLING_GRACE_SEC (default 7 days), STRIPE_SECRET_KEY,
 * STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, WEBFLIX_PAYMENTS_FAKE_WEBHOOK_SECRET,
 * WEBFLIX_PAYMENTS_FAKE_DELIVERY, WEBFLIX_PAYMENTS_FAKE_RETRIES_EXHAUSTED,
 * WEBFLIX_PAYMENTS_FAKE_PROMOTIONS.
 */
export function loadBillingConfig(input: AreaConfigInput): AreaConfigResult<BillingAreaConfig> {
  const issues: string[] = [];
  const production = input.environment === "production";
  // The fake's form would let anyone "pay" in production; the in-process reference provider
  // has no form, so a production deployment that names neither stays closed (no checkout can
  // ever complete) until Stripe is configured.
  const paymentProvider = choice(
    input,
    "WEBFLIX_PAYMENT_PROVIDER",
    PAYMENT_PROVIDER_ADAPTERS,
    production ? "memory" : "fake",
    issues,
  );
  if (production && paymentProvider === "fake") {
    issues.push("WEBFLIX_PAYMENT_PROVIDER=fake is not allowed in production");
  }
  const { STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET } = input.vars;
  let stripe: BillingAreaConfig["stripe"] = null;
  if (STRIPE_SECRET_KEY && STRIPE_PUBLISHABLE_KEY && STRIPE_WEBHOOK_SECRET) {
    stripe = {
      secretKey: STRIPE_SECRET_KEY,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      webhookSecret: STRIPE_WEBHOOK_SECRET,
    };
    if (!/^pk_/.test(STRIPE_PUBLISHABLE_KEY)) {
      issues.push("STRIPE_PUBLISHABLE_KEY: expected a publishable key (pk_…)");
    }
    if (production && /_test_/.test(STRIPE_SECRET_KEY)) {
      issues.push("STRIPE_SECRET_KEY: a test key in production");
    }
  } else if (paymentProvider === "stripe") {
    issues.push(
      "WEBFLIX_PAYMENT_PROVIDER=stripe: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_WEBHOOK_SECRET are required",
    );
  }
  return {
    config: {
      paymentProvider,
      graceSec: positiveInteger(input, "WEBFLIX_BILLING_GRACE_SEC", 7 * 24 * 60 * 60, issues),
      stripe,
      fake: {
        webhookSecret:
          secret(input, "WEBFLIX_PAYMENTS_FAKE_WEBHOOK_SECRET", 24, issues) ??
          DEV_FAKE_WEBHOOK_SECRET,
        delivery: choice(
          input,
          "WEBFLIX_PAYMENTS_FAKE_DELIVERY",
          FAKE_DELIVERY_MODES,
          "orderly",
          issues,
        ),
        retriesExhausted: choice(
          input,
          "WEBFLIX_PAYMENTS_FAKE_RETRIES_EXHAUSTED",
          FAKE_RETRIES_EXHAUSTED,
          "unpaid",
          issues,
        ),
        promotions: parseFakePromotions(
          input.vars.WEBFLIX_PAYMENTS_FAKE_PROMOTIONS ?? DEFAULT_FAKE_PROMOTIONS,
          issues,
        ),
      },
    },
    issues,
  };
}
