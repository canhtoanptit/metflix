import { type AreaConfigInput, type AreaConfigResult, choice, positiveInteger } from "../config.ts";

/** `memory` is the in-process reference; `fake` (packages/payments-fake) and `stripe`. */
export const PAYMENT_PROVIDER_ADAPTERS = ["memory", "fake", "stripe"] as const;

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
}

/**
 * Variables: WEBFLIX_PAYMENT_PROVIDER (default memory), WEBFLIX_BILLING_GRACE_SEC (default
 * 7 days), STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET.
 */
export function loadBillingConfig(input: AreaConfigInput): AreaConfigResult<BillingAreaConfig> {
  const issues: string[] = [];
  const paymentProvider = choice(
    input,
    "WEBFLIX_PAYMENT_PROVIDER",
    PAYMENT_PROVIDER_ADAPTERS,
    "memory",
    issues,
  );
  const { STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET } = input.vars;
  let stripe: BillingAreaConfig["stripe"] = null;
  if (STRIPE_SECRET_KEY && STRIPE_PUBLISHABLE_KEY && STRIPE_WEBHOOK_SECRET) {
    stripe = {
      secretKey: STRIPE_SECRET_KEY,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      webhookSecret: STRIPE_WEBHOOK_SECRET,
    };
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
    },
    issues,
  };
}
