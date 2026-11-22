import type { AreaPorts } from "@webflix/core";
import { MemoryPaymentProvider } from "@webflix/core/memory";
import { type AreaContext, notBuiltYet } from "./shared.ts";

/**
 * The billing area's port in the Worker. Owned by the billing area: it adds the fake provider
 * (state in D1) and the Stripe adapter (fetch-based, portable) here.
 */
export function createBillingPorts(context: AreaContext): Pick<AreaPorts, "payments"> {
  const { paymentProvider } = context.config.core.billing;
  if (paymentProvider !== "memory") {
    notBuiltYet("WEBFLIX_PAYMENT_PROVIDER", paymentProvider, "billing");
  }
  return { payments: new MemoryPaymentProvider({ clock: context.clock }) };
}
