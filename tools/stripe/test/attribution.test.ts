import { describe, expect, it } from "vitest";
import { anchorIds, attribute, inversions } from "../proof/attribution.ts";

describe("anchorIds", () => {
  it("reads the object, its customer, clock, subscription and payment references", () => {
    expect(
      anchorIds({
        id: "in_1",
        customer: "cus_1",
        parent: { subscription_details: { subscription: "sub_1" } },
        lines: { data: [{ pricing: { price_details: { price: "price_1" } } }] },
      }),
    ).toEqual(["in_1", "cus_1", "sub_1"]);
    expect(anchorIds({ id: "clock_1", object: "test_helpers.test_clock" })).toEqual(["clock_1"]);
    expect(anchorIds({ id: "promo_1", promotion: { coupon: "coupon_1" } })).toEqual([
      "promo_1",
      "coupon_1",
    ]);
    expect(anchorIds({ id: "pi_1", customer: { id: "cus_2" } })).toEqual(["pi_1", "cus_2"]);
  });
});

describe("attribute", () => {
  it("assigns by owned anchors and spreads ownership to dependent objects", () => {
    const items = [
      { seq: 0, object: { id: "ch_1", payment_intent: "pi_1" } }, // before its PaymentIntent is known
      { seq: 1, object: { id: "pi_1", customer: "cus_a" } },
      { seq: 2, object: { id: "price_x", product: "prod_cat" } },
      {
        seq: 3,
        object: { id: "sub_1", customer: "cus_a", items: { data: [{ price: { id: "price_x" } }] } },
      },
      { seq: 4, object: { id: "cus_zzz" } },
    ];
    const result = attribute(items, [
      { name: "catalogue", owned: new Set(["prod_cat"]), firstSeq: 0 },
      { name: "trial", owned: new Set(["cus_a"]), firstSeq: 0 },
    ]);
    expect(result.byOwner.get("catalogue")).toEqual([2]);
    expect(result.byOwner.get("trial")).toEqual([0, 1, 3]);
    expect(result.unattributed).toEqual([4]);
  });

  it("ignores deliveries from before an owner started", () => {
    const result = attribute(
      [{ seq: 0, object: { id: "cus_a" } }],
      [{ name: "x", owned: new Set(["cus_a"]), firstSeq: 1 }],
    );
    expect(result.unattributed).toEqual([0]);
  });

  it("reports anchors claimed by two owners", () => {
    const result = attribute(
      [{ seq: 0, object: { id: "cus_a" } }],
      [
        { name: "x", owned: new Set(["cus_a"]), firstSeq: 0 },
        { name: "y", owned: new Set(["cus_a"]), firstSeq: 0 },
      ],
    );
    expect(result.ambiguous).toEqual([0]);
    expect(result.byOwner.get("x")).toEqual([0]);
  });
});

describe("inversions", () => {
  it("counts pairs delivered against creation order, ignoring same-second ties", () => {
    const found = inversions([
      { seq: 0, created: 100, id: "evt_a", type: "invoice.paid" },
      { seq: 1, created: 99, id: "evt_b", type: "invoice.finalized" },
      { seq: 2, created: 100, id: "evt_c", type: "customer.subscription.updated" },
    ]);
    expect(found).toEqual([
      {
        earlier: { id: "evt_b", type: "invoice.finalized", created: 99 },
        later: { id: "evt_a", type: "invoice.paid", created: 100 },
      },
    ]);
  });
});
