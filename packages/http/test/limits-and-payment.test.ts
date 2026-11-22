/**
 * The account-keyed rate limits: PIN guessing (`profile-pin`) and money-moving requests
 * (`payment`: checkout confirmations and plan changes).
 */
import { ApiError } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { createTestApp, DEMO, type Device, onboard, signIn, type TestApp } from "./support.ts";

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

describe("the payment budget (per account)", () => {
  async function account(t: TestApp, email = "payer@example.com"): Promise<Device> {
    return (await onboard(t, { email })).device;
  }

  it("counts checkout confirmations and plan changes; another account is unaffected", async () => {
    const t = await strictApp();
    // Onboarding confirmed a checkout: one of the three.
    const device = await account(t);
    await device.api.changePlan({ body: { planId: "premium" } });
    await device.api.changePlan({ body: { planId: "basic" } });
    expect(await codeOf(device.api.changePlan({ body: { planId: "standard" } }))).toBe(
      "rate_limited",
    );
    const neighbour = await account(t, "neighbour@example.com");
    expect((await neighbour.api.changePlan({ body: { planId: "premium" } })).plan.id).toBe(
      "premium",
    );
  });
});
