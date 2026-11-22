import { createStripePaymentProvider } from "@webflix/adapters-stripe";
import type { AreaPorts, Logger, PaymentProvider } from "@webflix/core";
import { MemoryPaymentProvider } from "@webflix/core/memory";
import type { Database } from "@webflix/db";
import {
  createFakePaymentForm,
  createSqlFakeStore,
  FakePaymentProvider,
} from "@webflix/payments-fake";
import type { Hono } from "hono";
import type { ApiConfig } from "../config.ts";
import type { AreaContext } from "./shared.ts";

/** One fake provider per database, shared by the services and the payment form. */
const fakes = new WeakMap<Database, FakePaymentProvider>();

/**
 * The billing area's port in the Node runtime (dev, k8s), from `WEBFLIX_PAYMENT_PROVIDER`:
 * - `fake` (default outside production): `packages/payments-fake`, state in the mode's
 *   database (SQLite in dev, PostgreSQL on k8s), webhooks delivered in process and verified;
 * - `stripe`: `packages/adapters-stripe` with `STRIPE_*` (webhooks reach
 *   `/api/v1/webhooks/payments/stripe`, e.g. from `make stripe-listen`);
 * - `memory`: the in-process reference (no form; production's default, so a deployment that
 *   names no provider can never complete a checkout).
 */
export function createBillingPorts(context: AreaContext): Pick<AreaPorts, "payments"> {
  return { payments: createPaymentProvider(context) };
}

function createPaymentProvider(context: AreaContext): PaymentProvider {
  const { billing } = context.config.core;
  switch (billing.paymentProvider) {
    case "stripe": {
      // The loader refuses `stripe` without credentials; this keeps the types honest.
      if (!billing.stripe) throw new Error("Stripe credentials are missing");
      return createStripePaymentProvider({
        secretKey: billing.stripe.secretKey,
        webhookSecret: billing.stripe.webhookSecret,
        clock: context.clock,
        logger: context.logger.child({ component: "stripe" }),
      });
    }
    case "fake":
      return fakeProvider(context.database, context.config, context.logger, context.clock);
    default:
      return new MemoryPaymentProvider({ clock: context.clock });
  }
}

function fakeProvider(
  database: Database,
  config: ApiConfig,
  logger: Logger,
  clock: AreaContext["clock"],
): FakePaymentProvider {
  let fake = fakes.get(database);
  if (!fake) {
    const { fake: settings } = config.core.billing;
    fake = new FakePaymentProvider({
      store: createSqlFakeStore(database),
      webhookSecret: settings.webhookSecret,
      clock,
      logger: logger.child({ component: "payments-fake" }),
      retriesExhausted: settings.retriesExhausted,
      promotions: settings.promotions,
      delivery:
        settings.delivery === "unruly"
          ? { mode: "unruly", duplicateRate: 0.2, maxDelayMs: 2_000 }
          : { mode: settings.delivery },
    });
    fakes.set(database, fake);
  }
  return fake;
}

/**
 * The fake provider's payment form at `/_pay/*` (never in production, only with the fake):
 * card data in local modes goes there, never to the API. Mounted on the root app ahead of the
 * API's response-header middleware, so its pages keep their own strict headers. Delayed
 * webhook deliveries (unruly mode) are flushed every few seconds.
 */
export function mountBillingRoutes(root: Hono, config: ApiConfig, database: Database): void {
  if (config.core.environment === "production") return;
  if (config.core.billing.paymentProvider !== "fake") return;
  const fake = fakes.get(database);
  if (!fake) return;
  const form = createFakePaymentForm({ provider: fake });
  root.all("/_pay/*", async (c) => (await form(c.req.raw)) ?? c.notFound());
  const timer = setInterval(() => {
    fake.deliverPending().catch(() => {});
  }, 5_000);
  timer.unref();
}
