import { AppError, loadBillingConfig } from "@webflix/core";
import { describe, expect, it } from "vitest";
import { createBillingHarness } from "./harness.ts";

/**
 * Finding K3 (docs/KUBERNETES.md §9.11): a production deployment that names no payment provider
 * advertised the fake's form and started checkouts that could never complete, held per process.
 * It now has none: it says so and refuses, from configuration alone, the same on every replica.
 */
async function problem(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "expected an AppError").toBeInstanceOf(AppError);
  return (error as AppError).code;
}

describe("no payment provider configured", () => {
  it("is production's default; the fake and the in-process reference are refused there", () => {
    const production = (vars: Record<string, string>) =>
      loadBillingConfig({ environment: "production", vars });
    expect(production({})).toMatchObject({ config: { paymentProvider: "none" }, issues: [] });
    expect(production({ WEBFLIX_PAYMENT_PROVIDER: "memory" }).issues).toEqual([
      "WEBFLIX_PAYMENT_PROVIDER=memory is not allowed in production",
    ]);
    expect(production({ WEBFLIX_PAYMENT_PROVIDER: "fake" }).issues).toEqual([
      "WEBFLIX_PAYMENT_PROVIDER=fake is not allowed in production",
    ]);
    expect(loadBillingConfig({ environment: "development", vars: {} }).config.paymentProvider).toBe(
      "fake",
    );
  });

  it("says so, refuses to start or confirm a checkout, and every instance answers the same", async () => {
    const config = { WEBFLIX_PAYMENT_PROVIDER: "none" };
    const replicas = [
      await createBillingHarness({ config }),
      await createBillingHarness({ config }),
    ];
    for (const h of replicas) {
      expect(h.services.billing.config()).toEqual({ provider: "none" });
      const auth = await h.account();
      const accountId = auth.session.accountId;
      expect(await problem(h.services.billing.startCheckout(auth, { planId: "standard" }))).toBe(
        "payments_not_configured",
      );
      expect(await problem(h.services.billing.confirmCheckout(accountId, "any"))).toBe(
        "payments_not_configured",
      );
      expect(
        await problem(h.services.billing.validatePromotion({ code: "WEBFLIX50", planId: "basic" })),
      ).toBe("payments_not_configured");
      // No webhook is taken, whoever signs it.
      expect(
        await problem(
          h.services.billing.receiveWebhook(h.deps.payments.id, new Uint8Array(), "t=1,v1=x"),
        ),
      ).toBe("not_found");
      // Nothing to reconcile, nothing scheduled, the membership is simply none.
      expect(h.services.billing.scheduled(Date.now())).toEqual([]);
      expect(await h.services.billing.reconcile()).toEqual({
        listed: 0,
        recorded: 0,
        requeued: 0,
        resynced: 0,
      });
      const account = await h.services.account.getAccount(accountId);
      expect(account.membership?.status).toBe("none");
      expect(await h.repos.billing.getCustomer(accountId, h.deps.payments.id)).toBeNull();
    }
  });
});
