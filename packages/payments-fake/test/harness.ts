import type { CatalogueEntry } from "@webflix/core";
import type { PaymentProviderHarness } from "@webflix/core/testing";
import { FakePaymentProvider, type FakePaymentProviderOptions } from "../src/provider.ts";
import type { FakeStore } from "../src/store.ts";

/** A store that forwards every call to `inner` (tests override the calls they hold or count). */
export function forwardStore(inner: FakeStore): FakeStore {
  return {
    get: (kind, id) => inner.get(kind, id),
    byCustomer: (customerId, kinds) => inner.byCustomer(customerId, kinds),
    byKind: (kind, options) => inner.byKind(kind, options),
    write: (documents) => inner.write(documents),
    delete: (keys) => inner.delete(keys),
    reserveKey: (key, fingerprint, now) => inner.reserveKey(key, fingerprint, now),
    settleKey: (key, outcome) => inner.settleKey(key, outcome),
    releaseKey: (key) => inner.releaseKey(key),
    clock: (customerId) => inner.clock(customerId),
    setClock: (customerId, clock) => inner.setClock(customerId, clock),
    forget: (customerId, fragments) => inner.forget(customerId, fragments),
    guardVersions: (keys) => inner.guardVersions(keys),
    commit: (input) => inner.commit(input),
  };
}

export const TEST_WEBHOOK_SECRET = "whsec_fake_test_only_0000000000000000";

export const TEST_PRICES: { basic: CatalogueEntry; premium: CatalogueEntry } = {
  basic: {
    lookupKey: "webflix.basic.monthly.usd",
    productId: "webflix_basic",
    productName: "Basic",
    amountMinor: 799,
    currency: "USD",
  },
  premium: {
    lookupKey: "webflix.premium.monthly.usd",
    productId: "webflix_premium",
    productName: "Premium",
    amountMinor: 1899,
    currency: "USD",
  },
};

/** A fake provider over `store`, its catalogue synced: the contract suite's harness. */
export async function fakeContractHarness(
  store: FakeStore,
  options: Partial<FakePaymentProviderOptions> = {},
  cleanup?: () => Promise<void>,
): Promise<PaymentProviderHarness & { fake: FakePaymentProvider }> {
  const provider = new FakePaymentProvider({
    store,
    webhookSecret: TEST_WEBHOOK_SECRET,
    ...options,
  });
  await provider.syncCatalogue([TEST_PRICES.basic, TEST_PRICES.premium]);
  return {
    provider,
    fake: provider,
    prices: TEST_PRICES,
    now: () => Date.now(),
    confirmSetup: async (setup, card) => {
      await provider.confirmSetup(setup.clientSecret ?? "", card, { challenge: "complete" });
    },
    confirmPayment: async (subscription, card) => {
      await provider.confirmPayment(subscription.paymentClientSecret ?? "", card, {
        challenge: "complete",
      });
    },
    createPromotion: (input) => provider.definePromotion(input),
    webhook: async (options) => {
      const customer = await provider.createCustomer(
        { accountId: "acct-webhook", email: "webhook@example.test" },
        { idempotencyKey: `webhook-${crypto.randomUUID()}` },
      );
      const events = await provider.listEvents({ createdAfter: 0, limit: 1000 });
      const event = events.find((candidate) => candidate.customerId === customer.id);
      if (!event) throw new Error("no event to deliver");
      return { ...(await provider.signedDelivery(event, options)), id: event.id };
    },
    ...(cleanup ? { cleanup } : {}),
  };
}
