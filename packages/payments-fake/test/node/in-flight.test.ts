import { AppError, PaymentProviderError } from "@webflix/core";
import { createRepositories, migrateToLatest } from "@webflix/db";
import { createSqliteDatabase } from "@webflix/db/sqlite";
import { describe, expect, it } from "vitest";
import { createSqlFakeStore } from "../../src/sql-store.ts";
import type { FakeStore } from "../../src/store.ts";
import { type BillingHarness, createBillingHarness, DAY_MS } from "../billing/harness.ts";
import { forwardStore } from "../harness.ts";

/**
 * Finding K12 (docs/KUBERNETES.md §9.11): with several replicas, a member's request meets the
 * same idempotent provider call already running elsewhere (the worker, another replica's poll),
 * and the provider answers "in flight" (`unavailable`), or the projection is contended. Two
 * billing services share one SQLite database and one fake-provider store; one instance's
 * provider is held at a named point (after the provider did the work, before its idempotency key
 * records the outcome), so the other meets the key in flight. Nothing is timed.
 */
interface Pair {
  api: BillingHarness;
  worker: BillingHarness;
  close(): Promise<void>;
}

/** A store whose first settlement of a matching key waits until released. */
function holdKey(inner: FakeStore, matches: (key: string) => boolean) {
  let reached = () => {};
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let armed = true;
  const store: FakeStore = {
    ...forwardStore(inner),
    async settleKey(key, outcome) {
      if (armed && matches(key)) {
        armed = false;
        reached();
        await released;
      }
      return inner.settleKey(key, outcome);
    },
  };
  return { store, held, release };
}

async function twoInstances(
  wrap: { api?: (store: FakeStore) => FakeStore; worker?: (store: FakeStore) => FakeStore } = {},
): Promise<Pair> {
  const database = createSqliteDatabase({ path: ":memory:" });
  await migrateToLatest(database);
  const store = createSqlFakeStore(database);
  const api = await createBillingHarness({
    repos: createRepositories(database),
    store: wrap.api?.(store) ?? store,
  });
  const worker = await createBillingHarness({
    repos: createRepositories(database),
    store: wrap.worker?.(store) ?? store,
  });
  api.fake.attachWebhookReceiver(async ({ body, signature }) => {
    await worker.services.billing.receiveWebhook("fake", body, signature);
  });
  return { api, worker, close: () => database.close() };
}

/** What the HTTP layer would answer: an `AppError`'s code, or 500 for anything else. */
async function answer(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "ok",
    (error: unknown) => (error instanceof AppError ? error.code : "500 internal_error"),
  );
}

/** A member whose renewal failed (past_due) and who just confirmed a new card in the form. */
async function cardConfirmed(pair: Pair) {
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

const DEFAULT_CARD = (key: string) => key.includes("-default-card-");

describe("a member's request meets the same provider call in flight elsewhere", () => {
  it("a card-change poll while the worker's completion holds the key answers processing, then succeeded", async () => {
    let hold!: ReturnType<typeof holdKey>;
    const pair = await twoInstances({
      worker: (store) => {
        hold = holdKey(store, DEFAULT_CARD);
        return hold.store;
      },
    });
    try {
      const { accountId, setupId } = await cardConfirmed(pair);
      const draining = pair.worker.drain();
      await hold.held;
      // The worker made the card the default; its key has no outcome yet.
      const polled = await pair.api.services.billing
        .getPaymentMethodSetup(accountId, setupId)
        .catch((error: unknown) => error);
      expect(polled instanceof Error ? `${polled.name}: ${polled.message}` : polled).toEqual({
        id: setupId,
        status: "processing",
        clientSecret: null,
        createdAt: expect.any(String),
      });
      hold.release();
      await draining;
      const after = await pair.api.services.billing.getPaymentMethodSetup(accountId, setupId);
      expect(after.status).toBe("succeeded");
      expect((await pair.api.repos.billing.getMembership(accountId))?.status).toBe("active");
      expect(pair.worker.queue.deadLetters).toHaveLength(0);
    } finally {
      await pair.close();
    }
  });

  it("two card-change polls at once on two instances: the second answers processing", async () => {
    let hold!: ReturnType<typeof holdKey>;
    const pair = await twoInstances({
      api: (store) => {
        hold = holdKey(store, DEFAULT_CARD);
        return hold.store;
      },
    });
    try {
      const { accountId, setupId } = await cardConfirmed(pair);
      const first = pair.api.services.billing.getPaymentMethodSetup(accountId, setupId);
      await hold.held;
      expect(
        await answer(pair.worker.services.billing.getPaymentMethodSetup(accountId, setupId)),
      ).toBe("ok");
      expect(
        (await pair.worker.services.billing.getPaymentMethodSetup(accountId, setupId)).status,
      ).toBe("processing");
      hold.release();
      expect((await first).status).toBe("succeeded");
      expect(
        (await pair.worker.services.billing.getPaymentMethodSetup(accountId, setupId)).status,
      ).toBe("succeeded");
      expect((await pair.api.repos.billing.getMembership(accountId))?.status).toBe("active");
    } finally {
      await pair.close();
    }
  });

  it("two confirmations of one checkout at once: the second is told to retry, the checkout completes", async () => {
    let hold!: ReturnType<typeof holdKey>;
    const pair = await twoInstances({
      api: (store) => {
        hold = holdKey(store, (key) => key.includes("-subscribe-"));
        return hold.store;
      },
    });
    try {
      const auth = await pair.api.account();
      const accountId = auth.session.accountId;
      const started = await pair.api.services.billing.startCheckout(auth, { planId: "standard" });
      await pair.api.confirm(started.clientSecret, "visa");
      const first = pair.api.services.billing.confirmCheckout(accountId, started.id);
      await hold.held;
      expect(
        await answer(pair.worker.services.billing.confirmCheckout(accountId, started.id)),
      ).toBe("service_unavailable");
      hold.release();
      expect((await first).status).toBe("complete");
      // The retry answers the checkout as it now stands.
      expect(
        (await pair.worker.services.billing.confirmCheckout(accountId, started.id)).status,
      ).toBe("complete");
    } finally {
      await pair.close();
    }
  });
});

/** Every compare-and-set of the membership on this instance loses (others keep writing). */
function contend(h: BillingHarness) {
  const billing = h.repos.billing;
  const save = billing.saveMembership.bind(billing);
  let on = true;
  billing.saveMembership = async (record, expected) => (on ? false : save(record, expected));
  return () => {
    on = false;
  };
}

describe("a member's request whose projection write keeps losing the race", () => {
  it("a confirmation and its polls answer the checkout as it stands, and it completes once writes land", async () => {
    const pair = await twoInstances();
    try {
      const auth = await pair.api.account();
      const accountId = auth.session.accountId;
      const started = await pair.api.services.billing.startCheckout(auth, { planId: "standard" });
      await pair.api.confirm(started.clientSecret, "visa");
      const stop = contend(pair.api);
      expect(await answer(pair.api.services.billing.confirmCheckout(accountId, started.id))).toBe(
        "ok",
      );
      expect((await pair.api.services.billing.getCheckout(accountId, started.id)).status).toBe(
        "processing",
      );
      stop();
      expect((await pair.api.services.billing.getCheckout(accountId, started.id)).status).toBe(
        "complete",
      );
    } finally {
      await pair.close();
    }
  });

  it("a cancellation answers the membership as the provider now has it", async () => {
    const pair = await twoInstances();
    try {
      const auth = await pair.api.account();
      const accountId = auth.session.accountId;
      await pair.api.subscribe(auth, { card: "visa" });
      const stop = contend(pair.api);
      const canceled = await pair.api.services.billing
        .cancel(accountId)
        .catch((error: unknown) => error);
      expect(canceled instanceof Error ? `${canceled.name}: ${canceled.message}` : "ok").toBe("ok");
      expect(
        (canceled as { subscription: { canceledAt: string | null } }).subscription.canceledAt,
      ).not.toBeNull();
      stop();
      await pair.api.services.billing.syncAccount(accountId);
      expect((await pair.api.repos.billing.getMembership(accountId))?.cancelAtPeriodEnd).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it("a staff trial extension answers the extended trial", async () => {
    const pair = await twoInstances();
    try {
      const auth = await pair.api.account();
      const accountId = auth.session.accountId;
      await pair.api.subscribe(auth, { card: "visa" });
      const before = await pair.api.repos.billing.getMembership(accountId);
      contend(pair.api);
      const extended = await pair.api.services.billing
        .extendTrial({ accountId, days: 3 })
        .catch((error: unknown) => error);
      expect(extended instanceof Error ? `${extended.name}: ${extended.message}` : "ok").toBe("ok");
      const trialEndsAt = Date.parse((extended as { trialEndsAt: string }).trialEndsAt);
      expect(trialEndsAt - (before?.trialEndsAt ?? 0)).toBe(3 * DAY_MS);
    } finally {
      await pair.close();
    }
  });
});

describe("a member's request whose provider read fails for a moment", () => {
  it("answers service_unavailable (retry), never a 500", async () => {
    const pair = await twoInstances();
    try {
      const auth = await pair.api.account();
      const accountId = auth.session.accountId;
      await pair.api.subscribe(auth, { card: "visa" });
      const other = await pair.api.account();
      const started = await pair.api.services.billing.startCheckout(other, { planId: "basic" });
      const setupId = (await pair.api.services.billing.setupPaymentMethod(accountId)).id;
      pair.api.fake.retrieveSetup = async () => {
        throw new PaymentProviderError("unavailable", "the provider is not answering");
      };
      // A checkout waiting for its card (its client secret comes from the provider).
      expect(
        await answer(pair.api.services.billing.getCheckout(other.session.accountId, started.id)),
      ).toBe("service_unavailable");
      // A card change: starting one, and polling one.
      expect(await answer(pair.api.services.billing.setupPaymentMethod(accountId))).toBe(
        "service_unavailable",
      );
      expect(
        await answer(pair.api.services.billing.getPaymentMethodSetup(accountId, setupId)),
      ).toBe("service_unavailable");
    } finally {
      await pair.close();
    }
  });
});

/**
 * Finding K13: the worker's sync holds the membership while the request's sync runs. Before
 * each of the API instance's membership writes (up to `times`), the worker syncs the same
 * membership first, the way it does for each event of a burst (a renewal after a clock advance),
 * so the API's compare-and-set loses to it.
 */
function workerWritesFirst(pair: Pair, times: number) {
  const billing = pair.api.repos.billing;
  const save = billing.saveMembership.bind(billing);
  let left = times;
  billing.saveMembership = async (record, expected) => {
    if (left > 0) {
      left -= 1;
      await pair.worker.services.billing.syncAccount(record.accountId);
    }
    return save(record, expected);
  };
  return { raced: () => times - left };
}

const contended = (h: BillingHarness) =>
  h.logger.records
    .map((line) => line.msg)
    .filter((msg) => msg === "billing.sync_contended" || msg === "billing.sync_deferred");

describe("a request whose membership write meets the worker's (finding K13)", () => {
  it("the clock advance waits out the worker's writes and answers the moved clock, synced", async () => {
    const pair = await twoInstances();
    try {
      const auth = await pair.api.account();
      const accountId = auth.session.accountId;
      await pair.api.subscribe(auth, { card: "visa" });
      await pair.worker.drain();
      const race = workerWritesFirst(pair, 8);
      const advanced = await pair.api.services.billing
        .advanceClock(accountId, 8 * (DAY_MS / 1000))
        .catch((error: unknown) => (error instanceof AppError ? error.code : "500"));
      expect(typeof advanced === "string" ? advanced : "moved").toBe("moved");
      expect(race.raced()).toBeGreaterThanOrEqual(1);
      // Synced by the request itself, not deferred: the renewal is already in the projection.
      expect((await pair.api.repos.billing.getMembership(accountId))?.status).toBe("active");
      expect(contended(pair.api)).toEqual([]);
    } finally {
      await pair.close();
    }
  });

  it("a member's change waits out the worker's writes and answers the synced membership", async () => {
    const pair = await twoInstances();
    try {
      const auth = await pair.api.account();
      const accountId = auth.session.accountId;
      await pair.api.subscribe(auth, { card: "visa" });
      await pair.worker.drain();
      workerWritesFirst(pair, 8);
      const canceled = await pair.api.services.billing.cancel(accountId);
      expect(canceled.subscription.canceledAt).not.toBeNull();
      expect(contended(pair.api)).toEqual([]);
      expect((await pair.api.repos.billing.getMembership(accountId))?.cancelAtPeriodEnd).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it("when the record never stops changing: the clock still answers the moved clock, an account sync answers 503", async () => {
    const pair = await twoInstances();
    try {
      const auth = await pair.api.account();
      const accountId = auth.session.accountId;
      await pair.api.subscribe(auth, { card: "visa" });
      await pair.worker.drain();
      const before = await pair.api.fake.clockNow(
        (await pair.api.repos.billing.getCustomer(accountId, "fake"))?.customerId ?? "",
      );
      contend(pair.api);
      const advanced = await pair.api.services.billing
        .advanceClock(accountId, 3600)
        .catch((error: unknown) => (error instanceof AppError ? error.code : "500"));
      expect(typeof advanced === "string" ? advanced : Date.parse(advanced.now) - before).toBe(
        3_600_000,
      );
      expect(await answer(pair.api.services.billing.syncAccount(accountId))).toBe(
        "service_unavailable",
      );
    } finally {
      await pair.close();
    }
  });
});
