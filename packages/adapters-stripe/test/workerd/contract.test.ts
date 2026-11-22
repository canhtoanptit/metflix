import { env } from "cloudflare:workers";
import { describePaymentProviderContract } from "@webflix/core/testing";
import { describe, it } from "vitest";
import { sandboxHarness, sandboxReachable } from "../support/sandbox.ts";

const keys = {
  secretKey: env.STRIPE_SECRET_KEY ?? "",
  publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? "",
};

/**
 * The same contract with the adapter running inside workerd (the Workers runtime): `fetch` and
 * Web Crypto only, no Node, no SDK. Proves the adapter is portable against real Stripe.
 */
const skipped = await sandboxReachable(keys);
if (skipped === null) {
  describePaymentProviderContract("stripe (sandbox, workerd)", () => sandboxHarness(keys));
} else {
  describe("PaymentProvider contract: stripe (sandbox, workerd)", () => {
    it.skip(`skipped: ${skipped}`, () => {});
  });
}
