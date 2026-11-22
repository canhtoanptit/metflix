import {
  billingIdempotencyKey,
  type PaymentFailureCode,
  PaymentProviderError,
} from "@webflix/core";
import { migrateToLatest } from "@webflix/db";
import { createSqliteDatabase } from "@webflix/db/sqlite";
import { describe, expect, it } from "vitest";
import type { FakeTestCard } from "../../src/cards.ts";
import { FakePaymentProvider } from "../../src/provider.ts";
import { createSqlFakeStore } from "../../src/sql-store.ts";
import { type FakeStore, MemoryFakeStore } from "../../src/store.ts";
import { TEST_PRICES, TEST_WEBHOOK_SECRET } from "../harness.ts";

/**
 * Finding K2 (docs/KUBERNETES.md §9.11): API and worker replicas each run a fake provider over
 * one store. Here two `FakePaymentProvider` instances share one store (in memory, and SQLite
 * through the SQL store PostgreSQL and D1 also use). Once armed, the stores hold each instance's
 * first commit until both have reached it, so both computed from the same state and one of them
 * must lose the compare-and-set; nothing is timed.
 */
const DAY_SEC = 24 * 60 * 60;
const key = () => ({ idempotencyKey: billingIdempotencyKey(crypto.randomUUID(), 1) });

function forward(inner: FakeStore): FakeStore {
  return {
    get: (kind, id) => inner.get(kind, id),
    byCustomer: (customerId, kinds) => inner.byCustomer(customerId, kinds),
    byKind: (kind, options) => inner.byKind(kind, options),
    write: (documents) => inner.write(documents),
    delete: (keys) => inner.delete(keys),
    reserveKey: (k, fingerprint, now) => inner.reserveKey(k, fingerprint, now),
    settleKey: (k, outcome) => inner.settleKey(k, outcome),
    releaseKey: (k) => inner.releaseKey(k),
    clock: (customerId) => inner.clock(customerId),
    setClock: (customerId, clock) => inner.setClock(customerId, clock),
    guardVersions: (keys) => inner.guardVersions(keys),
    commit: (input) => inner.commit(input),
  };
}

/** Two views of one store whose first commits, once armed, meet before either goes ahead. */
function racing(inner: FakeStore) {
  let armed = false;
  let arrived = 0;
  let lost = 0;
  let release = () => {};
  let bothRead = Promise.resolve();
  const party = (): FakeStore => {
    let waiting = false;
    return {
      ...forward(inner),
      async commit(input) {
        if (armed && !waiting) {
          waiting = true;
          arrived += 1;
          if (arrived === 2) {
            armed = false;
            release();
          }
          await bothRead;
        }
        const committed = await inner.commit(input);
        if (!committed) lost += 1;
        return committed;
      },
    };
  };
  return {
    a: party(),
    b: party(),
    arm() {
      armed = true;
      arrived = 0;
      bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    lost: () => lost,
  };
}

const stores: [string, () => Promise<{ store: FakeStore; close(): Promise<void> }>][] = [
  ["memory", async () => ({ store: new MemoryFakeStore(), close: async () => {} })],
  [
    "SQLite",
    async () => {
      const database = createSqliteDatabase({ path: ":memory:" });
      await migrateToLatest(database);
      return { store: createSqlFakeStore(database), close: () => database.close() };
    },
  ],
];

async function failure(promise: Promise<unknown>): Promise<PaymentFailureCode> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PaymentProviderError);
  return (error as PaymentProviderError).code;
}

for (const [name, open] of stores) {
  describe(`two fake providers over one ${name} store`, () => {
    async function pair() {
      const { store, close } = await open();
      const race = racing(store);
      const make = (view: FakeStore) =>
        new FakePaymentProvider({ store: view, webhookSecret: TEST_WEBHOOK_SECRET });
      const a = make(race.a);
      const b = make(race.b);
      await a.syncCatalogue([TEST_PRICES.basic, TEST_PRICES.premium]);
      async function card(fake: FakePaymentProvider, customerId: string, test: FakeTestCard) {
        const setup = await fake.createSetup({ customerId }, key());
        await fake.confirmSetup(setup.clientSecret ?? "", test, { challenge: "complete" });
        return (await fake.retrieveSetup(setup.id))?.paymentMethod?.id ?? "";
      }
      async function member(fake: FakePaymentProvider) {
        const { id } = await fake.createCustomer(
          { accountId: crypto.randomUUID(), email: "member@example.test" },
          key(),
        );
        return { customerId: id, paymentMethodId: await card(fake, id, "visa") };
      }
      return { store, race, a, b, card, member, close };
    }

    it("keeps both redemptions when two customers redeem one promotion at once", async () => {
      const { store, race, a, b, member, close } = await pair();
      try {
        await a.definePromotion({ code: "RACE", percentOff: 10, maxRedemptions: 2 });
        const lookup = await a.validatePromotionCode({
          code: "RACE",
          priceLookupKey: TEST_PRICES.basic.lookupKey,
        });
        if (!lookup.valid) throw new Error("the promotion should be valid");
        const one = await member(a);
        const two = await member(b);
        const subscribe = (fake: FakePaymentProvider, who: typeof one) =>
          fake.createSubscription(
            {
              customerId: who.customerId,
              priceLookupKey: TEST_PRICES.basic.lookupKey,
              paymentMethodId: who.paymentMethodId,
              trialDays: 7,
              promotionId: lookup.promotionId,
            },
            key(),
          );
        race.arm();
        await Promise.all([subscribe(a, one), subscribe(b, two)]);
        expect(race.lost()).toBeGreaterThanOrEqual(1);
        const stored = (await store.get("promotion", "RACE"))?.data as { timesRedeemed: number };
        expect(stored.timesRedeemed).toBe(2);
        // The cap holds across instances: the code is used up.
        expect(
          await b.validatePromotionCode({
            code: "RACE",
            priceLookupKey: TEST_PRICES.basic.lookupKey,
          }),
        ).toMatchObject({ valid: false });
      } finally {
        await close();
      }
    });

    it("keeps both changes when two instances change one customer at once", async () => {
      const { race, a, b, card, member, close } = await pair();
      try {
        const { customerId, paymentMethodId } = await member(a);
        const subscription = await a.createSubscription(
          {
            customerId,
            priceLookupKey: TEST_PRICES.basic.lookupKey,
            paymentMethodId,
            trialDays: 7,
            promotionId: null,
          },
          key(),
        );
        const replacement = await card(b, customerId, "mastercard");
        race.arm();
        await Promise.all([
          a.setCancelAtPeriodEnd(
            { subscriptionId: subscription.id, cancelAtPeriodEnd: true },
            key(),
          ),
          b.setDefaultPaymentMethod(
            { customerId, paymentMethodId: replacement, subscriptionId: subscription.id },
            key(),
          ),
        ]);
        expect(race.lost()).toBe(1);
        const after = await a.retrieveSubscription(subscription.id);
        expect(after?.cancelAtPeriodEnd).toBe(true);
        expect(after?.defaultPaymentMethod?.id).toBe(replacement);
      } finally {
        await close();
      }
    });

    it("moves a customer's clock by both advances made at once", async () => {
      const { race, a, b, member, close } = await pair();
      try {
        const { customerId } = await member(a);
        const start = await a.clockNow(customerId);
        race.arm();
        await Promise.all([
          a.advanceClock(customerId, DAY_SEC),
          b.advanceClock(customerId, DAY_SEC),
        ]);
        expect(race.lost()).toBe(1);
        const moved = (await b.clockNow(customerId)) - start;
        expect(moved).toBeGreaterThanOrEqual(2 * DAY_SEC * 1000);
        expect(moved).toBeLessThan(2 * DAY_SEC * 1000 + 60_000);
      } finally {
        await close();
      }
    });

    it("gives up with a retryable error when every commit loses", async () => {
      const { store, a, member, close } = await pair();
      try {
        const { customerId, paymentMethodId } = await member(a);
        const losing = new FakePaymentProvider({
          store: { ...forward(store), commit: async () => false },
          webhookSecret: TEST_WEBHOOK_SECRET,
        });
        const code = await failure(
          losing.setDefaultPaymentMethod(
            { customerId, paymentMethodId, subscriptionId: null },
            key(),
          ),
        );
        expect(code).toBe("unavailable");
        expect(new PaymentProviderError(code).retryable).toBe(true);
      } finally {
        await close();
      }
    });
  });
}
