import type { AreaPorts } from "@webflix/core";
import { MemoryPaymentProvider } from "@webflix/core/memory";
import { type AreaContext, notBuiltYet } from "./shared.ts";

/**
 * The billing area's port in the Node runtime. Owned by the billing area: it adds the fake
 * provider (`packages/payments-fake`) and the Stripe adapter (`packages/adapters-stripe`) here.
 */
export function createBillingPorts(context: AreaContext): Pick<AreaPorts, "payments"> {
  const { paymentProvider } = context.config.core.billing;
  if (paymentProvider !== "memory") {
    notBuiltYet("WEBFLIX_PAYMENT_PROVIDER", paymentProvider, "billing");
  }
  return { payments: new MemoryPaymentProvider({ clock: context.clock }) };
}
