import type { AppContainer } from "../container.ts";
import { enforceRateLimit, requireAccount, requireAccountHolder } from "../session.ts";
import type { AppContext, AreaHandlers } from "./types.ts";

/**
 * The billing area's routes: plans and the membership, milestone 2's provider configuration,
 * checkout, plan-change previews, card replacement, invoices, promo codes, the payment webhook
 * and the fake provider's clock. Thin mappings onto `services.billing` and, for an account
 * whose membership is still milestone 1's mock, onto `services.account` exactly as before.
 */
export function createBillingHandlers(container: AppContainer): AreaHandlers<"billing"> {
  const { services } = container;
  const holder = (c: AppContext) => requireAccountHolder(container, c);
  const account = (c: AppContext) => requireAccount(container, c);

  return {
    // --- Membership (milestone 1's routes; the provider's membership when there is one) -------
    getAccount: async (_request, c) =>
      services.account.getAccount((await holder(c)).session.accountId),

    listPlans: () => services.billing.plans(),

    changePlan: async ({ body }, c) => {
      const accountId = (await holder(c)).session.accountId;
      if (await services.billing.usesProvider(accountId)) {
        return services.billing.changePlan(accountId, {
          planId: body.planId,
          previewToken: body.previewToken,
        });
      }
      // A card sent with a plan change is verified like any other: same budget.
      if (body.payment) await enforceRateLimit(container, c, "payment");
      return services.account.changePlan(accountId, body);
    },

    updatePaymentMethod: async ({ body }, c) =>
      services.account.updatePaymentMethod((await holder(c)).session.accountId, body.payment),

    cancelMembership: async (_request, c) => {
      const accountId = (await holder(c)).session.accountId;
      return (await services.billing.usesProvider(accountId))
        ? services.billing.cancel(accountId)
        : services.account.cancel(accountId);
    },

    resumeMembership: async (_request, c) => {
      const accountId = (await holder(c)).session.accountId;
      return (await services.billing.usesProvider(accountId))
        ? services.billing.resume(accountId)
        : services.account.resume(accountId);
    },

    // --- Milestone 2 (§5) ----------------------------------------------------------------------
    getBillingConfig: () => services.billing.config(),

    startCheckout: async ({ body }, c) => services.billing.startCheckout(await account(c), body),

    getCheckout: async ({ params }, c) =>
      services.billing.getCheckout((await account(c)).session.accountId, params.id),

    confirmCheckout: async ({ params }, c) =>
      services.billing.confirmCheckout((await account(c)).session.accountId, params.id),

    previewPlanChange: async ({ body }, c) =>
      services.billing.previewPlanChange((await holder(c)).session.accountId, body.planId),

    setupPaymentMethod: async (_request, c) =>
      services.billing.setupPaymentMethod((await holder(c)).session.accountId),

    getPaymentMethodSetup: async ({ params }, c) =>
      services.billing.getPaymentMethodSetup((await holder(c)).session.accountId, params.id),

    listInvoices: async ({ query }, c) =>
      services.billing.listInvoices((await holder(c)).session.accountId, {
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      }),

    validatePromotion: async ({ body }) => services.billing.validatePromotion(body),

    // Authenticated by the signature over the exact raw bytes, nothing else (§5.3).
    receivePaymentWebhook: async ({ params, body }, c) =>
      services.billing.receiveWebhook(
        params.provider,
        body,
        c.req.header("Stripe-Signature") ?? null,
      ),

    advanceBillingClock: async ({ body }, c) =>
      services.billing.advanceClock((await account(c)).session.accountId, body.seconds),
  };
}
