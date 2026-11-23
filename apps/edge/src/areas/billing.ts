import { createStripePaymentProvider } from "@webflix/adapters-stripe";
import type { AreaPorts, PaymentProvider } from "@webflix/core";
import { MemoryPaymentProvider } from "@webflix/core/memory";
import {
  createFakePaymentForm,
  createSqlFakeStore,
  FakePaymentProvider,
} from "@webflix/payments-fake";
import type { EdgeConfig, Env } from "../env.ts";
import type { AreaContext } from "./shared.ts";

/** One fake provider per D1 binding (per isolate), shared by the services and the form. */
const fakes = new WeakMap<object, FakePaymentProvider>();
const forms = new WeakMap<FakePaymentProvider, (request: Request) => Promise<Response | null>>();

/**
 * The billing area's port in the Worker, from `WEBFLIX_PAYMENT_PROVIDER`: the fake provider
 * with its state in D1 (default outside production), the Stripe adapter (fetch and Web Crypto,
 * the same code as on Node), or the in-process reference (which also stands in for `none`, no
 * provider: the billing service never calls it then).
 */
export function createBillingPorts(context: AreaContext): Pick<AreaPorts, "payments"> {
  return { payments: createPaymentProvider(context) };
}

function createPaymentProvider(context: AreaContext): PaymentProvider {
  const { billing } = context.config.core;
  switch (billing.paymentProvider) {
    case "stripe": {
      if (!billing.stripe) throw new Error("Stripe credentials are missing");
      return createStripePaymentProvider({
        secretKey: billing.stripe.secretKey,
        webhookSecret: billing.stripe.webhookSecret,
        clock: context.clock,
        logger: context.logger.child({ component: "stripe" }),
      });
    }
    case "fake": {
      let fake = fakes.get(context.env.DB);
      if (!fake) {
        const settings = billing.fake;
        fake = new FakePaymentProvider({
          store: createSqlFakeStore(context.database),
          webhookSecret: settings.webhookSecret,
          clock: context.clock,
          logger: context.logger.child({ component: "payments-fake" }),
          retriesExhausted: settings.retriesExhausted,
          promotions: settings.promotions,
          // No promise shared between requests on Workers (docs/CLOUDFLARE.md §2): the fake's
          // compare-and-set on D1 keeps concurrent operations correct without its in-memory queues.
          inProcessQueues: false,
          delivery:
            settings.delivery === "unruly"
              ? { mode: "unruly", duplicateRate: 0.2, maxDelayMs: 2_000 }
              : { mode: settings.delivery },
        });
        fakes.set(context.env.DB, fake);
      }
      return fake;
    }
    default:
      return new MemoryPaymentProvider({ clock: context.clock });
  }
}

/**
 * Requests the billing area serves outside the API in the Worker: the fake provider's payment
 * form at `/_pay/*` (never in production, only with the fake), ahead of the app so its pages
 * keep their own strict headers. Returns null for requests it leaves to the app. Delayed
 * (unruly) webhook deliveries are flushed on each of its requests and by the provider's own
 * calls; there are no timers in a Worker.
 */
export function handleBillingRequest(
  request: Request,
  env: Env,
  config: EdgeConfig,
): Promise<Response | null> | null {
  const { pathname } = new URL(request.url);
  if (pathname !== "/_pay" && !pathname.startsWith("/_pay/")) return null;
  const fake = fakes.get(env.DB);
  if (config.core.environment === "production" || !fake) return null;
  let form = forms.get(fake);
  if (!form) {
    form = createFakePaymentForm({ provider: fake });
    forms.set(fake, form);
  }
  return form(request);
}
