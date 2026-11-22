import type { CheckoutRecord, PaymentMethodSetupRecord } from "@webflix/core";
import { createRepositories, migrateToLatest } from "@webflix/db";
import { createSqliteDatabase } from "@webflix/db/sqlite";
import { describe, expect, it } from "vitest";
import { createSqlFakeStore } from "../../src/sql-store.ts";
import { type BillingHarness, createBillingHarness, DAY_MS } from "../billing/harness.ts";

/**
 * Finding K1 (docs/KUBERNETES.md §9.11): on Kubernetes the API replica that confirms a checkout
 * and the worker replica that processes the provider's events share one database and race. These
 * tests run two billing services over one SQLite database and one fake-provider store: `api`
 * answers the member, `worker` processes every webhook (the fake's deliveries are routed to it).
 * Each interleaving is forced at a named point by wrapping one repository method of one instance
 * (no sleeps): the confirmation's save of the subscription id on its checkout, the worker's
 * lookup of the checkouts to complete, the worker's record of a finished card change.
 */
interface Pair {
  api: BillingHarness;
  worker: BillingHarness;
  close(): Promise<void>;
}

async function twoInstances(): Promise<Pair> {
  const database = createSqliteDatabase({ path: ":memory:" });
  await migrateToLatest(database);
  const store = createSqlFakeStore(database);
  const api = await createBillingHarness({ repos: createRepositories(database), store });
  const worker = await createBillingHarness({ repos: createRepositories(database), store });
  // Every webhook the API's provider sends is verified, recorded and queued by the worker.
  api.fake.attachWebhookReceiver(async ({ body, signature }) => {
    await worker.services.billing.receiveWebhook("fake", body, signature);
  });
  return { api, worker, close: () => database.close() };
}

/** Runs `before` and `after` around the confirmation's save of the subscription id, once. */
function aroundConfirmationSave(
  h: BillingHarness,
  hooks: { before?: () => Promise<void>; after?: () => Promise<void> },
): void {
  const billing = h.repos.billing;
  const save = billing.saveCheckout.bind(billing);
  let armed = true;
  billing.saveCheckout = async (record: CheckoutRecord) => {
    const confirming = record.providerSubscriptionId !== null && record.status === "processing";
    if (!armed || !confirming) return save(record);
    armed = false;
    await hooks.before?.();
    await save(record);
    await hooks.after?.();
  };
}

/** An account with a confirmed card, ready for `confirmCheckout` (a trial: `processing`). */
async function readyToConfirm(pair: Pair) {
  const auth = await pair.api.account();
  const started = await pair.api.services.billing.startCheckout(auth, { planId: "standard" });
  await pair.api.confirm(started.clientSecret, "visa");
  return { accountId: auth.session.accountId, checkoutId: started.id };
}

async function settledState(pair: Pair, accountId: string, checkoutId: string) {
  return {
    membership: (await pair.worker.repos.billing.getMembership(accountId))?.status,
    stored: (await pair.worker.repos.billing.getCheckout(accountId, checkoutId))?.status,
  };
}

describe("checkout confirmation against the worker, two instances over one database", () => {
  it("the worker processes every event before the confirmation saves the subscription id", async () => {
    const pair = await twoInstances();
    try {
      const { accountId, checkoutId } = await readyToConfirm(pair);
      let processedFirst = false;
      aroundConfirmationSave(pair.api, {
        before: async () => {
          await pair.worker.drain();
          // The projection is already written: the checkout cannot be found by the worker yet.
          processedFirst =
            (await pair.worker.repos.billing.getMembership(accountId))?.status === "trialing";
        },
      });
      const confirmed = await pair.api.services.billing.confirmCheckout(accountId, checkoutId);
      expect(processedFirst).toBe(true);
      // The confirmation looks again after its save: complete in its own answer.
      expect(confirmed.status).toBe("complete");
      expect(await settledState(pair, accountId, checkoutId)).toEqual({
        membership: "trialing",
        stored: "complete",
      });
      // And a poll on either instance agrees.
      expect((await pair.worker.services.billing.getCheckout(accountId, checkoutId)).status).toBe(
        "complete",
      );
    } finally {
      await pair.close();
    }
  });

  it("the worker processes the events after the save, before the confirmation's own sync", async () => {
    const pair = await twoInstances();
    try {
      const { accountId, checkoutId } = await readyToConfirm(pair);
      aroundConfirmationSave(pair.api, { after: () => pair.worker.drain() });
      const confirmed = await pair.api.services.billing.confirmCheckout(accountId, checkoutId);
      expect(confirmed.status).toBe("complete");
      expect(await settledState(pair, accountId, checkoutId)).toEqual({
        membership: "trialing",
        stored: "complete",
      });
    } finally {
      await pair.close();
    }
  });

  it("the worker writes the projection before the save and looks for checkouts after it", async () => {
    const pair = await twoInstances();
    try {
      const { accountId, checkoutId } = await readyToConfirm(pair);
      // Hold the worker between its projection write and its checkout lookup.
      const workerBilling = pair.worker.repos.billing;
      const list = workerBilling.listCheckoutsForSubscription.bind(workerBilling);
      let reached = () => {};
      const reachedLookup = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let open = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      workerBilling.listCheckoutsForSubscription = async (provider, subscriptionId) => {
        reached();
        await gate;
        return list(provider, subscriptionId);
      };
      let draining: Promise<void> = Promise.resolve();
      let projectionFirst = false;
      aroundConfirmationSave(pair.api, {
        before: async () => {
          draining = pair.worker.drain();
          await reachedLookup;
          projectionFirst = (await workerBilling.getMembership(accountId))?.status === "trialing";
        },
        after: async () => {
          open();
          await draining;
        },
      });
      const confirmed = await pair.api.services.billing.confirmCheckout(accountId, checkoutId);
      expect(projectionFirst).toBe(true);
      expect(confirmed.status).toBe("complete");
      expect(await settledState(pair, accountId, checkoutId)).toEqual({
        membership: "trialing",
        stored: "complete",
      });
    } finally {
      await pair.close();
    }
  });

  it("the confirmation dies right after its save (events first); a poll on the worker completes it", async () => {
    const pair = await twoInstances();
    try {
      const { accountId, checkoutId } = await readyToConfirm(pair);
      aroundConfirmationSave(pair.api, {
        before: () => pair.worker.drain(),
        after: async () => {
          throw new Error("the API replica is gone");
        },
      });
      await expect(
        pair.api.services.billing.confirmCheckout(accountId, checkoutId),
      ).rejects.toThrow("the API replica is gone");
      expect(await settledState(pair, accountId, checkoutId)).toEqual({
        membership: "trialing",
        stored: "processing",
      });
      // No event will come again; the member's poll (any replica) settles it.
      expect((await pair.worker.services.billing.getCheckout(accountId, checkoutId)).status).toBe(
        "complete",
      );
      expect((await settledState(pair, accountId, checkoutId)).stored).toBe("complete");
    } finally {
      await pair.close();
    }
  });
});

describe("card replacement against the worker, two instances over one database", () => {
  /** A member whose renewal failed (past_due), about to replace the card. */
  async function pastDueMember(pair: Pair) {
    const auth = await pair.api.account();
    const accountId = auth.session.accountId;
    await pair.api.subscribe(auth, { card: "charge-declined" });
    await pair.worker.drain();
    await pair.api.services.billing.advanceClock(accountId, 8 * (DAY_MS / 1000));
    await pair.worker.drain();
    expect((await pair.api.repos.billing.getMembership(accountId))?.status).toBe("past_due");
    const setup = await pair.api.services.billing.setupPaymentMethod(accountId);
    await pair.api.confirm(setup.clientSecret, "visa");
    return { accountId, setupId: setup.id };
  }

  async function defaultCardLast4(pair: Pair, accountId: string) {
    const membership = await pair.api.repos.billing.getMembership(accountId);
    const subscription = await pair.api.fake.retrieveSubscription(
      membership?.providerSubscriptionId ?? "",
    );
    return subscription?.defaultPaymentMethod?.last4;
  }

  it("the worker finishes the card change before the member polls", async () => {
    const pair = await twoInstances();
    try {
      const { accountId, setupId } = await pastDueMember(pair);
      await pair.worker.drain();
      const polled = await pair.api.services.billing.getPaymentMethodSetup(accountId, setupId);
      expect(polled.status).toBe("succeeded");
      expect((await pair.api.repos.billing.getMembership(accountId))?.status).toBe("active");
      expect(await defaultCardLast4(pair, accountId)).toBe("4242");
      expect(pair.worker.queue.deadLetters).toHaveLength(0);
    } finally {
      await pair.close();
    }
  });

  it("the member's poll finishes it before the worker sees the event", async () => {
    const pair = await twoInstances();
    try {
      const { accountId, setupId } = await pastDueMember(pair);
      const polled = await pair.api.services.billing.getPaymentMethodSetup(accountId, setupId);
      expect(polled.status).toBe("succeeded");
      await pair.worker.drain();
      expect(pair.worker.queue.deadLetters).toHaveLength(0);
      expect((await pair.api.repos.billing.getMembership(accountId))?.status).toBe("active");
      const invoices = await pair.api.repos.billing.listInvoices(accountId, {
        limit: 10,
        before: null,
      });
      // The renewal was paid once, in full (the trial's invoice was free).
      const charged = invoices.filter((invoice) => invoice.amountPaidMinor > 0);
      expect(charged).toHaveLength(1);
      expect(charged[0]?.amountPaidMinor).toBe(charged[0]?.totalMinor);
    } finally {
      await pair.close();
    }
  });

  it("the worker dies paying the open invoice after the new card became the default; a poll on the API finishes it", async () => {
    const pair = await twoInstances();
    try {
      const { accountId, setupId } = await pastDueMember(pair);
      const recorded: PaymentMethodSetupRecord["status"][] = [];
      const workerBilling = pair.worker.repos.billing;
      const saveSetup = workerBilling.saveSetup.bind(workerBilling);
      workerBilling.saveSetup = async (record) => {
        recorded.push(record.status);
        return saveSetup(record);
      };
      pair.worker.fake.payInvoice = async () => {
        throw new Error("the worker replica is gone");
      };
      await pair.worker.drain();
      expect(await defaultCardLast4(pair, accountId)).toBe("4242");
      // Nothing claims the change finished while its last step is undone.
      expect(recorded).not.toContain("succeeded");
      const polled = await pair.api.services.billing.getPaymentMethodSetup(accountId, setupId);
      expect(polled.status).toBe("succeeded");
      expect((await pair.api.repos.billing.getMembership(accountId))?.status).toBe("active");
    } finally {
      await pair.close();
    }
  });
});
