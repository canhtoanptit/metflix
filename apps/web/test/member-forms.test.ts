import { ApiError, createProblem, MOCK_CARDS } from "@webflix/contracts";
import { makeAvatar, makeProfile } from "@webflix/contracts/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { upgradeChargeToday } from "../src/features/member/account/membership.ts";
import { profileChanges } from "../src/features/member/profiles/EditProfilePage.tsx";
import { clampForKids, raisesCeiling } from "../src/features/member/profiles/maturity.ts";
import { cardErrorsFrom, describeDecline } from "../src/features/member/shared/billing.ts";
import { formatCountdown, possessive } from "../src/features/member/shared/format.ts";
import {
  detectCardBrand,
  formatCardNumber,
  formatExpiryInput,
  passesLuhn,
  toCardPayment,
  validateCardForm,
  validateCardNumber,
  validateCvc,
  validateEmail,
  validateExpiry,
  validateNewPassword,
  validateProfileName,
} from "../src/features/member/shared/validation.ts";
import {
  clearDraft,
  draftPassword,
  readDraft,
  rememberPassword,
  updateDraft,
} from "../src/features/member/signup/draft.ts";
import { pickAvatars } from "../src/features/member/signup/ProfileStep.tsx";

const NOW = new Date(2026, 10, 21); // November 2026

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

describe("card fields", () => {
  it("formats numbers as the member types, by brand", () => {
    expect(formatCardNumber("4242424242424242")).toBe("4242 4242 4242 4242");
    expect(formatCardNumber("4242-4242 42")).toBe("4242 4242 42");
    expect(formatCardNumber("378282246310005")).toBe("3782 822463 10005");
    expect(formatCardNumber("37828224631000599")).toBe("3782 822463 10005");
  });

  it("detects the brand the server will store", () => {
    expect(detectCardBrand("4242")).toBe("visa");
    expect(detectCardBrand("5555")).toBe("mastercard");
    expect(detectCardBrand("3782")).toBe("amex");
    expect(detectCardBrand("6011")).toBe("discover");
    expect(detectCardBrand("9999")).toBe("other");
  });

  it("checks the Luhn digit, and every mock test card passes it", () => {
    for (const card of Object.values(MOCK_CARDS)) expect(passesLuhn(card)).toBe(true);
    expect(validateCardNumber("4242 4242 4242 4241")).toMatch(/doesn't look right/);
    expect(validateCardNumber("4242 4242")).toMatch(/incomplete/);
    expect(validateCardNumber("")).toBe("Enter your card number.");
  });

  it("formats the expiry with a separator that Backspace can cross", () => {
    expect(formatExpiryInput("1", "")).toBe("1");
    expect(formatExpiryInput("4", "")).toBe("04 / ");
    expect(formatExpiryInput("12", "1")).toBe("12 / ");
    expect(formatExpiryInput("12 / 3", "12 / ")).toBe("12 / 3");
    expect(formatExpiryInput("12 / 30", "12 / 3")).toBe("12 / 30");
    // Backspace right after the separator removes the month's last digit.
    expect(formatExpiryInput("12 /", "12 / ")).toBe("1");
  });

  it("rejects expired, malformed and implausible expiry dates", () => {
    expect(validateExpiry("12 / 30", NOW)).toBeNull();
    expect(validateExpiry("11 / 26", NOW)).toBeNull();
    expect(validateExpiry("10 / 26", NOW)).toMatch(/expired/);
    expect(validateExpiry("13 / 30", NOW)).toBe("Use the format MM / YY.");
    expect(validateExpiry("12 / 99", NOW)).toBe("Check the expiry year.");
  });

  it("security code length depends on the brand", () => {
    expect(validateCvc("123", "visa")).toBeNull();
    expect(validateCvc("1234", "amex")).toBeNull();
    expect(validateCvc("123", "amex")).toMatch(/4 digits/);
    expect(validateCvc("", "visa")).toBe("Enter the security code.");
  });

  it("validates the whole form and builds the request payment", () => {
    const form = {
      cardNumber: "4242 4242 4242 4242",
      expiry: "08 / 29",
      cvc: "123",
      nameOnCard: "  Sam Rivera ",
    };
    expect(validateCardForm(form, NOW)).toEqual({});
    expect(toCardPayment(form)).toEqual({
      method: "card",
      cardNumber: "4242424242424242",
      expMonth: 8,
      expYear: 2029,
      cvc: "123",
      nameOnCard: "Sam Rivera",
    });
    expect(
      Object.keys(validateCardForm({ cardNumber: "", expiry: "", cvc: "", nameOnCard: "" }, NOW)),
    ).toEqual(["cardNumber", "expiry", "cvc", "nameOnCard"]);
  });

  it("maps each decline reason onto the field to fix", () => {
    const declined = new ApiError(
      createProblem("payment_declined", { declineReason: "insufficient_funds" }),
    );
    expect(cardErrorsFrom(declined)).toEqual({ cardNumber: "Insufficient funds on this card." });
    expect(describeDecline("expired_card").field).toBe("expiry");
    expect(describeDecline("card_declined").title).toBe("Your card was declined");
    const invalid = new ApiError(
      createProblem("validation_failed", {
        issues: [{ location: "body", path: "payment.cvc", message: "bad", code: "invalid_string" }],
      }),
    );
    expect(cardErrorsFrom(invalid)).toEqual({ cvc: "Check the security code." });
  });
});

describe("sign-up draft", () => {
  beforeEach(() => {
    clearDraft();
    sessionStorage.clear();
  });

  it("keeps email and plan across reloads (session storage) but never the password", () => {
    updateDraft({ email: "sam@example.com" });
    updateDraft({ planId: "standard" });
    rememberPassword("correct horse battery");
    expect(readDraft()).toEqual({ email: "sam@example.com", planId: "standard" });
    expect(draftPassword()).toBe("correct horse battery");
    const stored = JSON.stringify({ ...sessionStorage });
    expect(stored).toContain("sam@example.com");
    expect(stored).not.toContain("correct horse battery");
  });

  it("ignores tampered storage", () => {
    sessionStorage.setItem("webflix.signup.v1", JSON.stringify({ email: 3, planId: "gold" }));
    expect(readDraft()).toEqual({ email: null, planId: null });
    sessionStorage.setItem("webflix.signup.v1", "{not json");
    expect(readDraft()).toEqual({ email: null, planId: null });
  });

  it("clearing forgets everything", () => {
    updateDraft({ email: "sam@example.com", planId: "basic" });
    rememberPassword("secret-password");
    clearDraft();
    expect(readDraft()).toEqual({ email: null, planId: null });
    expect(draftPassword()).toBeNull();
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
