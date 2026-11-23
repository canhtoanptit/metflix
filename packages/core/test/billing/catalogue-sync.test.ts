/**
 * The catalogue sync before the first checkout shares no promise between requests (on Workers one
 * request may not await a promise another request settles, docs/CLOUDFLARE.md §2): concurrent
 * first checkouts each sync, a sync that meets the provider's "in flight" answer is a retryable
 * 503 and is not remembered, and once one succeeded nobody syncs again.
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/index.ts";
import { PaymentProviderError } from "../../src/ports/payment-provider.ts";
import { createMember, eventServices } from "../events/helpers.ts";

type T = Awaited<ReturnType<typeof eventServices>>;

/** Counts the provider's catalogue syncs; the first `failures` answer "in flight". */
function countSyncs(t: T, failures = 0) {
  const provider = t.ports.payments;
  const original = provider.syncCatalogue.bind(provider);
  const counter = { calls: 0 };
  let left = failures;
  provider.syncCatalogue = async (entries) => {
    counter.calls += 1;
    // Let concurrent callers all reach the provider before any of them finishes.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (left-- > 0)
      throw new PaymentProviderError("unavailable", "a request with this key is in flight");
    return original(entries);
  };
  return counter;
}

describe("the catalogue sync before the first checkout", () => {
  it("runs for each concurrent first checkout, then never again", async () => {
    const t = await eventServices({}, {});
    const syncs = countSyncs(t);
    const [a, b] = await Promise.all([
      createMember(t, "acc-sync-a", { membership: false }),
      createMember(t, "acc-sync-b", { membership: false }),
    ]);
    const started = await Promise.all([
      t.services.billing.startCheckout(a.as("adult"), { planId: "basic" }),
      t.services.billing.startCheckout(b.as("adult"), { planId: "basic" }),
    ]);
    expect(started.every((checkout) => checkout.clientSecret)).toBe(true);
    expect(syncs.calls).toBe(2);
    const c = await createMember(t, "acc-sync-c", { membership: false });
    await t.services.billing.startCheckout(c.as("adult"), { planId: "basic" });
    expect(syncs.calls).toBe(2);
  });

  it("answers the provider's in-flight refusal with a retryable 503, and syncs on the retry", async () => {
    const t = await eventServices({}, {});
    const syncs = countSyncs(t, 1);
    const member = await createMember(t, "acc-sync-busy", { membership: false });
    const refused = await t.services.billing
      .startCheckout(member.as("adult"), { planId: "basic" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).code).toBe("service_unavailable");
    const retried = await t.services.billing.startCheckout(member.as("adult"), { planId: "basic" });
    expect(retried.clientSecret).toBeTruthy();
    expect(syncs.calls).toBe(2);
  });
});
