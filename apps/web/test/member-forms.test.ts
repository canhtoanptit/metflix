import { makeAvatar, makeProfile } from "@webflix/contracts/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { upgradeChargeToday } from "../src/features/member/account/membership.ts";
import {
  describeDecline,
  describePromotionFailure,
  formatSignedMoney,
  promotionAmount,
  promotionReach,
} from "../src/features/member/billing/copy.ts";
import { profileChanges } from "../src/features/member/profiles/EditProfilePage.tsx";
import { clampForKids, raisesCeiling } from "../src/features/member/profiles/maturity.ts";
import { formatCountdown, possessive } from "../src/features/member/shared/format.ts";
import {
  validateEmail,
  validateNewPassword,
  validateProfileName,
} from "../src/features/member/shared/validation.ts";
import { clearDraft, readDraft, updateDraft } from "../src/features/member/signup/draft.ts";
import { pickAvatars } from "../src/features/member/signup/ProfileStep.tsx";

describe("email and password rules", () => {
  it("accepts real addresses and explains typos", () => {
    expect(validateEmail("  Sam@Example.com ")).toBeNull();
    expect(validateEmail("")).toBe("Enter your email address.");
    expect(validateEmail("sam@example")).toMatch(/doesn't look like an email/);
    expect(validateEmail("sam example.com")).toMatch(/doesn't look like an email/);
  });

  it("asks for at least 8 characters for a new password", () => {
    expect(validateNewPassword("")).toBe("Create a password.");
    expect(validateNewPassword("short")).toBe("Use at least 8 characters.");
    expect(validateNewPassword("correct horse")).toBeNull();
  });

  it("profile names are required, short and unique (case-insensitively)", () => {
    expect(validateProfileName("  ")).toBe("Enter a name.");
    expect(validateProfileName("x".repeat(31))).toMatch(/30 characters/);
    expect(validateProfileName("mara", ["Mara"])).toMatch(/already has this name/);
    expect(validateProfileName("Robin", ["Mara"])).toBeNull();
  });
});

describe("payment copy", () => {
  it("says what each decline means and what to do, without a card field to blame", () => {
    expect(describeDecline("card_declined").title).toBe("Your card was declined");
    expect(describeDecline("insufficient_funds").title).toMatch(/insufficient funds/);
    expect(describeDecline("expired_card").title).toBe("Your card has expired");
    // An unknown reason (or none) still reads as a decline with a way forward.
    expect(describeDecline(null).body).toMatch(/another card/);
  });

  it("explains why a promo code can't be used", () => {
    expect(describePromotionFailure("expired")).toBe("This code has expired.");
    expect(describePromotionFailure("exhausted")).toBe("This code has been used up.");
    expect(describePromotionFailure("not_applicable")).toMatch(/doesn't apply to this plan/);
    expect(describePromotionFailure("already_redeemed")).toMatch(/already used/);
    expect(describePromotionFailure(undefined)).toMatch(/don't recognize/);
  });

  it("states a code's effect from the server's terms", () => {
    const base = { code: "WEBFLIX50", description: null, amountOff: null, durationInMonths: null };
    expect(promotionAmount({ ...base, percentOff: 50, duration: "once" })).toBe("50% off");
    expect(promotionReach({ ...base, percentOff: 50, duration: "once" })).toBe(
      "your first payment",
    );
    expect(promotionReach({ ...base, percentOff: 10, duration: "forever" })).toBe("every payment");
    expect(
      promotionReach({ ...base, percentOff: 10, duration: "repeating", durationInMonths: 3 }),
    ).toBe("payments for your first 3 months");
    expect(
      promotionAmount({
        ...base,
        percentOff: null,
        amountOff: { amountMinor: 500, currency: "USD" },
        duration: "once",
      }),
    ).toMatch(/5\.00 off/);
  });

  it("shows credits with a minus sign", () => {
    expect(formatSignedMoney({ amountMinor: -1295, currency: "USD" })).toMatch(/^−\$12\.95$/);
    expect(formatSignedMoney({ amountMinor: 598, currency: "USD" })).toBe("$5.98");
  });
});

describe("sign-up draft", () => {
  beforeEach(() => {
    clearDraft();
    sessionStorage.clear();
  });

  it("keeps email and plan across reloads (session storage), nothing else", () => {
    updateDraft({ email: "sam@example.com" });
    updateDraft({ planId: "standard" });
    expect(readDraft()).toEqual({ email: "sam@example.com", planId: "standard" });
    const stored = JSON.stringify({ ...sessionStorage });
    expect(stored).toContain("sam@example.com");
    expect(Object.keys(JSON.parse(Object.values(sessionStorage)[0] ?? "{}"))).toEqual([
      "email",
      "planId",
    ]);
  });

  it("ignores tampered storage", () => {
    sessionStorage.setItem("webflix.signup.v2", JSON.stringify({ email: 3, planId: "gold" }));
    expect(readDraft()).toEqual({ email: null, planId: null });
    sessionStorage.setItem("webflix.signup.v2", "{not json");
    expect(readDraft()).toEqual({ email: null, planId: null });
  });

  it("clearing forgets everything", () => {
    updateDraft({ email: "sam@example.com", planId: "basic" });
    clearDraft();
    expect(readDraft()).toEqual({ email: null, planId: null });
  });
});

describe("profiles", () => {
  it("gives each new profile a different avatar, kids from the kids group", () => {
    const groups = [
      { avatars: [makeAvatar({ id: "a1" }), makeAvatar({ id: "a2" }), makeAvatar({ id: "a3" })] },
      { avatars: [makeAvatar({ id: "k1" }), makeAvatar({ id: "k2" })] },
    ];
    const rows = [
      { isKids: false, avatarId: null },
      { isKids: true, avatarId: null },
      { isKids: false, avatarId: null },
    ];
    const ids = pickAvatars(groups, rows).map((avatar) => avatar.id);
    expect(ids).toEqual(["a1", "k2", "a3"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps the avatars the member chose, and never gives another row the same one", () => {
    const groups = [
      { avatars: [makeAvatar({ id: "a1" }), makeAvatar({ id: "a2" }), makeAvatar({ id: "a3" })] },
      { avatars: [makeAvatar({ id: "k1" }), makeAvatar({ id: "k2" })] },
    ];
    const rows = [
      { isKids: false, avatarId: "a2" },
      { isKids: false, avatarId: null },
      { isKids: true, avatarId: "k1" },
    ];
    const ids = pickAvatars(groups, rows).map((avatar) => avatar.id);
    expect(ids[0]).toBe("a2");
    expect(ids[2]).toBe("k1");
    expect(new Set(ids).size).toBe(3);
  });

  it("only sends what changed, so an untouched maturity rating never asks for the password", () => {
    const profile = makeProfile({ name: "Mara", maturityCeiling: "13+" });
    const form = {
      name: "Mara ",
      avatar: profile.avatar,
      isKids: false,
      maturityCeiling: "13+" as const,
      ...profile.settings,
      autoplayPreviews: !profile.settings.autoplayPreviews,
    };
    expect(profileChanges(profile, form)).toEqual({
      settings: { autoplayPreviews: !profile.settings.autoplayPreviews },
    });
    expect(profileChanges(profile, { ...form, maturityCeiling: "18+" })).toMatchObject({
      maturityCeiling: "18+",
    });
  });

  it("knows which maturity changes need the password, and caps kids at 7+", () => {
    expect(raisesCeiling("13+", "18+")).toBe(true);
    expect(raisesCeiling("18+", "13+")).toBe(false);
    expect(clampForKids("16+", true)).toBe("7+");
    expect(clampForKids("ALL", true)).toBe("ALL");
    expect(clampForKids("16+", false)).toBe("16+");
  });
});

describe("copy helpers", () => {
  it("formats countdowns and possessives", () => {
    expect(formatCountdown(42)).toBe("0:42");
    expect(formatCountdown(125.2)).toBe("2:06");
    expect(possessive("Mara")).toBe("Mara's");
    expect(possessive("Kids")).toBe("Kids'");
  });
});

describe("plan changes", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-11-01T12:00:00Z");
  const endIn = (days: number) => new Date(now + days * DAY).toISOString();

  it("charges the price difference for the days left, rounded to the cent like the server", () => {
    // $7.99 → $22.99 with the whole 30-day period ahead: the full difference.
    expect(upgradeChargeToday(799, 2299, endIn(30), now)).toEqual({
      amountMinor: 1500,
      daysLeft: 30,
    });
    // Half the period left: half the difference.
    expect(upgradeChargeToday(799, 2299, endIn(15), now)).toEqual({
      amountMinor: 750,
      daysLeft: 15,
    });
    // 10.5 days left: 1500 × 10.5 / 30 = 525 cents, and it reads as 11 days.
    expect(upgradeChargeToday(799, 2299, endIn(10.5), now)).toEqual({
      amountMinor: 525,
      daysLeft: 11,
    });
  });

  it("never charges for a downgrade or a period that has already ended", () => {
    expect(upgradeChargeToday(2299, 799, endIn(20), now).amountMinor).toBe(0);
    expect(upgradeChargeToday(799, 2299, endIn(-1), now)).toEqual({ amountMinor: 0, daysLeft: 0 });
  });
});
