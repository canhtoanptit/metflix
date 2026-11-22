import type Stripe from "stripe";
import type { Scenario } from "../context.ts";
import { CURRENCIES, lookupKey, PLANS, productId } from "./helpers.ts";

interface SyncResult {
  productsCreated: number;
  pricesCreated: number;
  pricesReplaced: number;
  unchanged: number;
}

/**
 * The catalogue sync the adapter needs (blueprint §5.4): Webflix owns plans and prices; Stripe
 * gets a product per plan (custom id, so retrieval is the idempotency check) and a price per
 * plan and currency found by lookup key. A changed amount cannot be edited (Stripe prices are
 * immutable), so a new price takes over the lookup key atomically and the old one is archived.
 */
async function syncCatalogue(s: Scenario): Promise<SyncResult> {
  const result: SyncResult = {
    productsCreated: 0,
    pricesCreated: 0,
    pricesReplaced: 0,
    unchanged: 0,
  };
  for (const plan of PLANS) {
    const id = productId(plan.plan);
    s.own(id);
    try {
      await s.stripe.products.retrieve(id);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      const product = await s.stripe.products.create(
        { id, name: plan.name, metadata: { webflix_plan: plan.plan } },
        { idempotencyKey: `webflix-catalogue-product-${id}` },
      );
      s.record(`product created ${id}`, product);
      result.productsCreated++;
    }
  }

  const keys = PLANS.flatMap((p) => CURRENCIES.map((c) => lookupKey(p.plan, c)));
  const existing = await s.stripe.prices.list({ lookup_keys: keys, limit: 100 });
  const byKey = new Map(existing.data.map((price) => [price.lookup_key, price]));

  for (const plan of PLANS) {
    for (const currency of CURRENCIES) {
      const key = lookupKey(plan.plan, currency);
      const amount = plan.amounts[currency];
      const current = byKey.get(key);
      const matches =
        current?.active &&
        current.currency === currency &&
        current.unit_amount === amount &&
        current.recurring?.interval === "month" &&
        (typeof current.product === "string" ? current.product : current.product.id) ===
          productId(plan.plan);
      if (matches) {
        s.own(current.id);
        result.unchanged++;
        continue;
      }
      const created = await s.stripe.prices.create(
        {
          product: productId(plan.plan),
          currency,
          unit_amount: amount,
          recurring: { interval: "month" },
          lookup_key: key,
          transfer_lookup_key: current !== undefined,
          metadata: { webflix_plan: plan.plan },
        },
        // Deterministic per (key, amount): a retried sync cannot create two prices.
        { idempotencyKey: `webflix-catalogue-price-${key}-${amount}` },
      );
      s.own(created.id);
      s.record(`price created ${key}`, created);
      if (current) {
        await s.stripe.prices.update(current.id, { active: false });
        result.pricesReplaced++;
      } else {
        result.pricesCreated++;
      }
    }
  }
  return result;
}

export async function catalogue(s: Scenario): Promise<void> {
  const first = await s.step("sync (first pass)", () => syncCatalogue(s));
  s.observe("first pass", first, undefined, "creates everything only in a fresh sandbox");

  const callsBefore = s.calls.length;
  const second = await s.step("sync (second pass)", () => syncCatalogue(s));
  const writes = s.calls.slice(callsBefore).filter((c) => c.method !== "GET");
  s.expect(
    "second pass changes nothing",
    { ...second, writes: writes.length },
    {
      productsCreated: 0,
      pricesCreated: 0,
      pricesReplaced: 0,
      unchanged: PLANS.length * CURRENCIES.length,
      writes: 0,
    },
  );

  const listed = await s.stripe.prices.list({
    lookup_keys: PLANS.flatMap((p) => CURRENCIES.map((c) => lookupKey(p.plan, c))),
    limit: 100,
  });
  s.record("prices by lookup key", listed);

  // A price change on a proof-only key: each run flips the amount, so it always exercises the
  // transfer (the real plan keys above stay untouched).
  await s.step("price change through transfer_lookup_key", async () => {
    const key = "webflix.proof.transfer.monthly.usd";
    const product = "webflix_proof_transfer";
    s.own(product);
    try {
      await s.stripe.products.retrieve(product);
    } catch {
      await s.stripe.products.create({ id: product, name: "Webflix proof: price transfer" });
    }
    const before = (await s.stripe.prices.list({ lookup_keys: [key], limit: 1 })).data[0];
    if (before) s.own(before.id);
    const amount = before?.unit_amount === 100 ? 200 : 100;
    const next: Stripe.Price = await s.stripe.prices.create({
      product,
      currency: "usd",
      unit_amount: amount,
      recurring: { interval: "month" },
      lookup_key: key,
      transfer_lookup_key: true,
    });
    s.own(next.id);
    s.record("new price takes the lookup key", next);
    if (before) {
      const old = await s.stripe.prices.update(before.id, { active: false });
      s.record("old price after transfer and archive", old);
      s.expect("old price lost its lookup key", old.lookup_key, null);
      s.expect("old price archived", old.active, false);
    }
    const after = (await s.stripe.prices.list({ lookup_keys: [key], limit: 10 })).data;
    s.expect(
      "exactly one price holds the key afterwards",
      after.map((p) => p.id),
      [next.id],
    );
  });
}
