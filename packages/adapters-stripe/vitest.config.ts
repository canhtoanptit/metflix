import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const stripeBindings = {
  // Handed from the runner's environment to the Worker's bindings, never written anywhere.
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "",
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
};

/**
 * - `node`: the adapter against recorded Stripe traffic (tools/stripe/fixtures) and stubs;
 * - `sandbox`: the port's contract suite against the real Stripe sandbox, on Node;
 * - `workerd`: the same contract with the adapter inside the Workers runtime.
 * The sandbox projects run their cases only when `STRIPE_SECRET_KEY` and
 * `STRIPE_PUBLISHABLE_KEY` are set (`make stripe-sandbox` writes them to
 * `.cache/stripe/stripe.env`); otherwise every case reports itself skipped, with the reason.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/sandbox/**", "test/workerd/**"],
        },
      },
      {
        test: {
          name: "sandbox",
          include: ["test/sandbox/**/*.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 120_000,
          // The sandbox allows 25 requests per second: one file at a time.
          fileParallelism: false,
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: { compatibilityDate: "2026-11-19", bindings: stripeBindings },
          }),
        ],
        test: {
          name: "workerd",
          include: ["test/workerd/**/*.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
