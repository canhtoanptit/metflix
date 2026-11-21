/**
 * The account-keyed rate limits: PIN guessing (`profile-pin`) and card testing (`payment`),
 * and the payment-method endpoint they protect.
 */
import { ApiError } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import {
  APPROVED_CARD,
  createTestApp,
  DECLINED_CARD,
  DEMO,
  type Device,
  onboard,
  signIn,
  type TestApp,
} from "./support.ts";

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => (ApiError.is(error) ? error.code : String(error)),
  );
}

/** Strict PIN limit (as outside dev) and a small card-verification budget per account. */
async function strictApp(): Promise<TestApp> {
  return createTestApp({
    config: { WEBFLIX_RATE_LIMIT_PROFILE_PIN: "5/60", WEBFLIX_RATE_LIMIT_PAYMENT: "3/600" },
  });
}

describe("profile-pin: only PIN attempts on locked profiles count, per account", () => {
  it("never limits switching to an unlocked profile", async () => {
    const t = await strictApp();
    const device = await signIn(t, DEMO.email, DEMO.password, "Switcher/1.0");
    for (let switches = 0; switches < 20; switches += 1) {
      const profileId = switches % 2 ? "pr-demo" : "pr-kids";
      const session = await device.api.selectProfile({ body: { profileId } });
      expect(session.activeProfile?.id).toBe(profileId);
    }
    // Asking for a locked profile without a PIN is not a guess either.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(await codeOf(device.api.selectProfile({ body: { profileId: "pr-locked" } }))).toBe(
        "profile_pin_required",
      );
    }
  });

  it("counts every PIN attempt account-wide, and keeps unlocked profiles available", async () => {
    const t = await strictApp();
    const device = await signIn(t, DEMO.email, DEMO.password, "Guesser/1.0");
    // A second locked profile, so switching targets is tried as a way around the limit (set in
    // the store: the demo account's profiles cannot be locked through the API).
    await t.deps.repos.profiles.update("demo-account", "pr-demo", {
      pinHash: await t.deps.passwords.hash("9876"),
      updatedAt: t.clock.now(),
    });
    const guess = (profileId: string, pin: string) =>
      codeOf(device.api.selectProfile({ body: { profileId, pin } }));
    // Right and wrong PINs alike: five attempts per minute.
    expect(await guess("pr-locked", "1234")).toBeNull();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await guess("pr-locked", "0000")).toBe("profile_pin_invalid");
    }
    expect(await guess("pr-locked", "1234")).toBe("rate_limited");
    expect(await guess("pr-demo", "9876")).toBe("rate_limited");
    // Another device of the same account shares the budget.
    const other = await signIn(t, DEMO.email, DEMO.password, "Other/1.0");
    expect(
      await codeOf(other.api.selectProfile({ body: { profileId: "pr-demo", pin: "9876" } })),
    ).toBe("rate_limited");
    // Unlocked profiles stay one click away meanwhile.
    expect(
      (await device.api.selectProfile({ body: { profileId: "pr-kids" } })).activeProfile?.id,
    ).toBe("pr-kids");
    t.clock.advance(61_000);
    expect(await guess("pr-locked", "1234")).toBeNull();
  });
});

describe("PUT /account/payment-method", () => {
  async function account(t: TestApp): Promise<Device> {
    return (await onboard(t, { email: "payer@example.com" })).device;
  }

  it("replaces the card, keeping only brand, last four and expiry", async () => {
    const t = await createTestApp();
    const device = await account(t);
    const before = await device.api.getAccount();
    const updated = await device.api.updatePaymentMethod({
      body: {
        payment: {
          ...APPROVED_CARD,
          cardNumber: "5555 5555 5555 4444",
          expMonth: 3,
          expYear: 2033,
        },
      },
    });
    expect(updated.paymentMethod).toEqual({
      brand: "mastercard",
      last4: "4444",
      expMonth: 3,
      expYear: 2033,
    });
    expect((await device.api.getAccount()).paymentMethod).toEqual(updated.paymentMethod);
    const stored = await t.deps.repos.accounts.get(updated.account.id);
    expect(JSON.stringify(stored)).not.toContain("5555555555554444");
    expect(JSON.stringify(stored)).not.toContain(APPROVED_CARD.cvc);
    // The plan and the billing period are untouched.
    expect(updated.subscription).toEqual(before.subscription);
    expect(updated.plan).toEqual(before.plan);
  });

  it("declines like sign-up and changes nothing", async () => {
    const t = await createTestApp();
    const device = await account(t);
    const before = (await device.api.getAccount()).paymentMethod;
    const cases = [
      [DECLINED_CARD, "card_declined"],
      [{ ...APPROVED_CARD, cardNumber: "4000000000009995" }, "insufficient_funds"],
      [{ ...APPROVED_CARD, expMonth: 1, expYear: 2020 }, "expired_card"],
    ] as const;
    for (const [payment, reason] of cases) {
      const error = await device.api
        .updatePaymentMethod({ body: { payment } })
        .catch((caught: unknown) => caught);
      expect(ApiError.is(error, "payment_declined") && error.problem.declineReason).toBe(reason);
    }
    expect(
      await codeOf(
        device.api.updatePaymentMethod({ body: { payment: { ...APPROVED_CARD, cvc: "1" } } }),
      ),
    ).toBe("validation_failed");
    expect((await device.api.getAccount()).paymentMethod).toEqual(before);
  });

  it("limits card verifications per account, plan changes with a card included", async () => {
    const t = await strictApp();
    const device = await account(t);
    await device.api.updatePaymentMethod({ body: { payment: APPROVED_CARD } });
    expect(await codeOf(device.api.updatePaymentMethod({ body: { payment: DECLINED_CARD } }))).toBe(
      "payment_declined",
    );
    await device.api.changePlan({ body: { planId: "premium", payment: APPROVED_CARD } });
    expect(await codeOf(device.api.updatePaymentMethod({ body: { payment: APPROVED_CARD } }))).toBe(
      "rate_limited",
    );
    expect(
      await codeOf(device.api.changePlan({ body: { planId: "basic", payment: APPROVED_CARD } })),
    ).toBe("rate_limited");
    // A plan change without a card verifies nothing and is not limited.
    expect((await device.api.changePlan({ body: { planId: "basic" } })).plan.id).toBe("basic");
    // Per account: another account is unaffected.
    const neighbour = (await onboard(t, { email: "neighbour@example.com" })).device;
    await neighbour.api.updatePaymentMethod({ body: { payment: APPROVED_CARD } });
  });
});
