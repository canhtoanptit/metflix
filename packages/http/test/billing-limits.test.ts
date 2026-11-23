/**
 * Security review M1: billing's member routes that reach the payment provider are bounded per
 * account, and a promo code can be guessed no faster through checkout than through validation.
 * Polls are never refused: they answer from stored state when the provider was read moments ago.
 */
import { ApiError } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { createTestApp, type Device, onboard, type TestApp } from "./support.ts";

async function codeOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "ok",
    (error: unknown) => (ApiError.is(error) ? error.code : String(error)),
  );
}

async function bareAccount(t: TestApp, email: string): Promise<Device> {
  const device = t.device();
  await device.api.signup({ body: { email, password: "correct horse battery" } });
  return device;
}

/** Counts the provider's reads (the calls a poll could make). */
function countReads(t: TestApp) {
  const provider = t.ports.payments;
  const counts = { setup: 0, subscription: 0 };
  const setup = provider.retrieveSetup.bind(provider);
  const subscription = provider.retrieveSubscription.bind(provider);
  provider.retrieveSetup = async (id) => {
    counts.setup += 1;
    return setup(id);
  };
  provider.retrieveSubscription = async (id) => {
    counts.subscription += 1;
    return subscription(id);
  };
  return counts;
}

describe("one promo-code budget, whichever route is used", () => {
  it("guesses through checkout and through validation share the `promotion` budget", async () => {
    const t = await createTestApp();
    const device = await bareAccount(t, "guesser@example.com");
    for (let i = 0; i < 5; i += 1) {
      expect(
        await codeOf(
          device.api.validatePromotion({ body: { code: `GUESS${i}`, planId: "basic" } }),
        ),
      ).toBe("promotion_code_invalid");
    }
    for (let i = 5; i < 10; i += 1) {
      expect(
        await codeOf(
          device.api.startCheckout({ body: { planId: "basic", promotionCode: `GUESS${i}` } }),
        ),
      ).toBe("promotion_code_invalid");
    }
    // The eleventh lookup, through either route, is refused with a Retry-After.
    const refused = await device.request("/api/v1/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webflix-Client": "web" },
      body: JSON.stringify({ planId: "basic", promotionCode: "GUESS10" }),
    });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(
      await codeOf(device.api.validatePromotion({ body: { code: "GUESS11", planId: "basic" } })),
    ).toBe("rate_limited");
    // A checkout without a code is not a lookup: it still starts.
    expect((await device.api.startCheckout({ body: { planId: "basic" } })).status).toBe(
      "requires_setup",
    );
  });

  it("the code the open checkout already carries is not charged again (a page reloaded)", async () => {
    const t = await createTestApp();
    t.ports.payments.definePromotion({ code: "WEBFLIX50", percentOff: 50 });
    const device = await bareAccount(t, "reloader@example.com");
    const started = await device.api.startCheckout({
      body: { planId: "basic", promotionCode: "WEBFLIX50" },
    });
    expect(started.promotion?.code).toBe("WEBFLIX50");
    // Nine more guesses spend the rest of the budget.
    for (let i = 0; i < 9; i += 1) {
      expect(
        await codeOf(device.api.validatePromotion({ body: { code: `NOPE${i}`, planId: "basic" } })),
      ).toBe("promotion_code_invalid");
    }
    // Picking the checkout up again with its own code still works; another code does not.
    for (let i = 0; i < 3; i += 1) {
      const again = await device.api.startCheckout({
        body: { planId: "basic", promotionCode: "webflix50" },
      });
      expect(again.id).toBe(started.id);
    }
    expect(
      await codeOf(device.api.startCheckout({ body: { planId: "basic", promotionCode: "OTHER" } })),
    ).toBe("rate_limited");
  });
});

describe("member routes that call the provider are bounded per account", () => {
  it("counts checkout starts, card setups and plan-change previews on one `billing` budget", async () => {
    const t = await createTestApp({ config: { WEBFLIX_RATE_LIMIT_BILLING: "6/600" } });
    // Onboarding started one checkout.
    const { device } = await onboard(t, { email: "busy@example.com", planId: "basic" });
    expect(await codeOf(device.api.previewPlanChange({ body: { planId: "premium" } }))).toBe("ok");
    expect(await codeOf(device.api.previewPlanChange({ body: { planId: "standard" } }))).toBe("ok");
    expect(await codeOf(device.api.setupPaymentMethod())).toBe("ok");
    expect(await codeOf(device.api.setupPaymentMethod())).toBe("ok");
    expect(await codeOf(device.api.previewPlanChange({ body: { planId: "premium" } }))).toBe("ok");
    expect(await codeOf(device.api.previewPlanChange({ body: { planId: "premium" } }))).toBe(
      "rate_limited",
    );
    expect(await codeOf(device.api.setupPaymentMethod())).toBe("rate_limited");
    // Per account: another member is unaffected.
    const other = await onboard(t, { email: "calm@example.com", planId: "basic" });
    expect(await codeOf(other.device.api.previewPlanChange({ body: { planId: "premium" } }))).toBe(
      "ok",
    );
    // The window passes: the member is served again.
    t.clock.advance(601_000);
    expect(await codeOf(device.api.setupPaymentMethod())).toBe("ok");
  });
});

describe("polls answer from stored state when the provider was read moments ago", () => {
  it("a checkout waiting for its card: 200 polls at once, all answered, no provider read", async () => {
    const t = await createTestApp();
    const device = await bareAccount(t, "poller@example.com");
    const started = await device.api.startCheckout({ body: { planId: "standard" } });
    const reads = countReads(t);
    const answers = await Promise.all(
      Array.from({ length: 200 }, () => device.api.getCheckout({ params: { id: started.id } })),
    );
    expect(answers.every((checkout) => checkout.clientSecret === started.clientSecret)).toBe(true);
    expect(reads).toEqual({ setup: 0, subscription: 0 });
  });

  it("a first payment being confirmed: the provider is read at most once per account every two seconds", async () => {
    const t = await createTestApp();
    // A card whose trial was used: the second account pays its first invoice.
    await onboard(t, { email: "first@example.com" });
    const device = await bareAccount(t, "second@example.com");
    const started = await device.api.startCheckout({ body: { planId: "standard" } });
    await t.ports.payments.confirmSetup(started.clientSecret ?? "", "visa");
    const confirmed = await device.api.confirmCheckout({ params: { id: started.id } });
    expect(confirmed.status).toBe("requires_payment");
    const reads = countReads(t);
    const polls = await Promise.all(
      Array.from({ length: 50 }, () => device.api.getCheckout({ params: { id: started.id } })),
    );
    expect(polls.every((checkout) => checkout.status === "requires_payment")).toBe(true);
    expect(polls.every((checkout) => checkout.clientSecret === confirmed.clientSecret)).toBe(true);
    expect(reads.subscription).toBeLessThanOrEqual(1);
    // The member pays; the next poll after the window reads the provider and completes.
    await t.ports.payments.confirmPayment(confirmed.clientSecret ?? "", "visa");
    t.clock.advance(2_100);
    expect((await device.api.getCheckout({ params: { id: started.id } })).status).toBe("complete");
  });

  it("a card change: 50 polls at once read the provider at most once, and it still completes", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "card@example.com" });
    const setup = await device.api.setupPaymentMethod();
    const reads = countReads(t);
    // The member is still in the provider's form: every poll asks whether it is done yet.
    const polls = await Promise.all(
      Array.from({ length: 50 }, () =>
        device.api.getPaymentMethodSetup({ params: { id: setup.id } }),
      ),
    );
    expect(polls.every((answer) => answer.status === "requires_confirmation")).toBe(true);
    expect(polls.every((answer) => answer.clientSecret === setup.clientSecret)).toBe(true);
    expect(reads.setup).toBeLessThanOrEqual(1);
    await t.ports.payments.confirmSetup(setup.clientSecret ?? "", "mastercard");
    t.clock.advance(2_100);
    expect((await device.api.getPaymentMethodSetup({ params: { id: setup.id } })).status).toBe(
      "succeeded",
    );
  });
});
