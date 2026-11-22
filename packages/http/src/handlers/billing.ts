import { PLAN_CATALOG } from "@webflix/core";
import type { AppContainer } from "../container.ts";
import { notImplemented } from "../routing.ts";
import { enforceRateLimit, requireAccountHolder } from "../session.ts";
import type { AppContext, AreaHandlers } from "./types.ts";

/**
 * The billing area's routes: plans and the membership (milestone 1's mock billing, until billing
 * replaces it), and milestone 2's provider configuration, checkout, plan-change previews, card
 * replacement, invoices, promo codes, the payment webhook and the fake provider's clock. Thin
 * mappings onto `services.account` and `services.billing`; `notImplemented()` until the billing
 * area implements them.
 */
export function createBillingHandlers(container: AppContainer): AreaHandlers<"billing"> {
  const { services } = container;
  const holder = (c: AppContext) => requireAccountHolder(container, c);

  return {
    // --- Milestone 1 --------------------------------------------------------------------------
    getAccount: async (_request, c) =>
      services.account.getAccount((await holder(c)).session.accountId),

    listPlans: () => ({ items: [...PLAN_CATALOG] }),

    changePlan: async ({ body }, c) => {
      const auth = await holder(c);
      // A card sent with a plan change is verified like any other: same budget.
      if (body.payment) await enforceRateLimit(container, c, "payment");
      return services.account.changePlan(auth.session.accountId, body);
    },

    updatePaymentMethod: async ({ body }, c) =>
      services.account.updatePaymentMethod((await holder(c)).session.accountId, body.payment),

    cancelMembership: async (_request, c) =>
      services.account.cancel((await holder(c)).session.accountId),

    resumeMembership: async (_request, c) =>
      services.account.resume((await holder(c)).session.accountId),

    // --- Milestone 2 (§5) ----------------------------------------------------------------------
    getBillingConfig: notImplemented(),
    startCheckout: notImplemented(),
    getCheckout: notImplemented(),
    confirmCheckout: notImplemented(),
    previewPlanChange: notImplemented(),
    setupPaymentMethod: notImplemented(),
    getPaymentMethodSetup: notImplemented(),
    listInvoices: notImplemented(),
    validatePromotion: notImplemented(),
    receivePaymentWebhook: notImplemented(),
    advanceBillingClock: notImplemented(),
  };
}
