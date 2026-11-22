import { describePaymentProviderContract } from "@webflix/core/testing";
import { describe, it } from "vitest";
import { sandboxHarness, sandboxReachable } from "../support/sandbox.ts";

const keys = {
  secretKey: process.env.STRIPE_SECRET_KEY ?? "",
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
};

/**
 * The PaymentProvider contract against the real Stripe sandbox, on Node (docs/BLUEPRINT-M2.md
 * §5.5: the same checks run against both providers, which keeps the fake honest).
 */
const skipped = await sandboxReachable(keys);
if (skipped === null) {
  describePaymentProviderContract("stripe (sandbox, Node)", () => sandboxHarness(keys));
} else {
  describe("PaymentProvider contract: stripe (sandbox, Node)", () => {
    it.skip(`skipped: ${skipped}`, () => {});
  });
}
