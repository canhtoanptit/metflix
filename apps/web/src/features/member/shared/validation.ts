/**
 * Client-side validation for the member forms. Mirrors the contract's rules (`EmailAddress`,
 * `Password`, `MockCardPayment`, `ProfileName`) without importing zod, so the auth and sign-up
 * chunks stay small. The server stays authoritative: these only decide when to help early.
 *
 * Every validator returns a sentence for the member, or null when the value is fine.
 */
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PROFILE_NAME_MAX_LENGTH,
} from "@webflix/contracts";

// --- Email ------------------------------------------------------------------------------------

/** Trimmed and lowercased, like the server does before validating. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

// Deliberately permissive (one @, a dot in the domain, no spaces): the server has the final say,
// and rejecting a real address client-side is worse than letting a typo through to it.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function validateEmail(value: string): string | null {
  const email = normalizeEmail(value);
  if (email.length === 0) return "Enter your email address.";
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return "That doesn't look like an email address. Check for typos.";
  }
  return null;
}

// --- Passwords --------------------------------------------------------------------------------

export function validateNewPassword(value: string): string | null {
  if (value.length === 0) return "Create a password.";
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return `Use no more than ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}

/** Re-entering the password chosen on step 1 (the draft keeps it in memory only). */
export function validateChosenPassword(value: string): string | null {
  if (value.length === 0) return "Enter the password you chose.";
  return validateNewPassword(value) === null
    ? null
    : `The password you chose has at least ${PASSWORD_MIN_LENGTH} characters.`;
}

export function validateCurrentPassword(value: string): string | null {
  return value.length === 0 ? "Enter your password." : null;
}

// --- Profiles ---------------------------------------------------------------------------------

export function validateProfileName(
  value: string,
  otherNames: readonly string[] = [],
): string | null {
  const name = value.trim();
  if (name.length === 0) return "Enter a name.";
  if (name.length > PROFILE_NAME_MAX_LENGTH) {
    return `Keep it to ${PROFILE_NAME_MAX_LENGTH} characters or fewer.`;
  }
  const lower = name.toLocaleLowerCase();
  if (otherNames.some((other) => other.trim().toLocaleLowerCase() === lower)) {
    return "Another profile already has this name.";
  }
  return null;
}

// --- Cards ------------------------------------------------------------------------------------

export type CardBrand = "visa" | "mastercard" | "amex" | "discover" | "other";

export const CARD_BRAND_LABELS: Record<CardBrand, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  other: "Card",
};

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Same prefixes as the server's `cardBrand`, so the stored brand matches what we showed. */
export function detectCardBrand(digits: string): CardBrand {
  if (/^4/.test(digits)) return "visa";
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(digits)) return "mastercard";
  if (/^3[47]/.test(digits)) return "amex";
  if (/^(6011|65|64[4-9])/.test(digits)) return "discover";
  return "other";
}

/** Longest number a brand issues; American Express is 15 digits, others up to 19. */
export function maxCardLength(brand: CardBrand): number {
  return brand === "amex" ? 15 : 19;
}

/** `4242424242424242` → `4242 4242 4242 4242`; American Express groups 4-6-5. */
export function formatCardNumber(value: string): string {
  const digits = digitsOnly(value);
  const brand = detectCardBrand(digits);
  const limited = digits.slice(0, maxCardLength(brand));
  if (brand === "amex") {
    return [limited.slice(0, 4), limited.slice(4, 10), limited.slice(10, 15)]
      .filter(Boolean)
      .join(" ");
  }
  return limited.replace(/(\d{4})(?=\d)/g, "$1 ");
}

export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function validateCardNumber(value: string): string | null {
  const digits = digitsOnly(value);
  if (digits.length === 0) return "Enter your card number.";
  const brand = detectCardBrand(digits);
  const tooShort = brand === "amex" ? digits.length < 15 : digits.length < 13;
  if (tooShort) return "This card number looks incomplete.";
  if (!passesLuhn(digits)) return "Check your card number. It doesn't look right.";
  return null;
}

/**
 * Format the expiry as the member types: `0`→`0`, `12`→`12 / `, `1228`→`12 / 28`, `4`→`04 / `.
 * Deleting through the separator removes the month digit, so Backspace never feels stuck.
 */
export function formatExpiryInput(next: string, previous: string): string {
  let digits = digitsOnly(next).slice(0, 4);
  const deleting = next.length < previous.length;
  if (deleting && previous.endsWith(" / ") && !next.endsWith(" / ") && digits.length === 2) {
    digits = digits.slice(0, 1);
  }
  if (digits.length === 1 && Number(digits) > 1) digits = `0${digits}`;
  if (digits.length < 2) return digits;
  if (digits.length === 2) return deleting ? digits : `${digits} / `;
  return `${digits.slice(0, 2)} / ${digits.slice(2)}`;
}

export interface Expiry {
  month: number;
  /** Four-digit year. */
  year: number;
}

export function parseExpiry(value: string): Expiry | null {
  const digits = digitsOnly(value);
  if (digits.length !== 4) return null;
  const month = Number(digits.slice(0, 2));
  const year = 2000 + Number(digits.slice(2));
  if (month < 1 || month > 12) return null;
  return { month, year };
}

export function validateExpiry(value: string, now = new Date()): string | null {
  if (digitsOnly(value).length === 0) return "Enter the expiry date.";
  const expiry = parseExpiry(value);
  if (!expiry) return "Use the format MM / YY.";
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  if (expiry.year < year || (expiry.year === year && expiry.month < month)) {
    return "This card has expired. Use a card with a later expiry date.";
  }
  if (expiry.year > year + 20) return "Check the expiry year.";
  return null;
}

export function validateCvc(value: string, brand: CardBrand): string | null {
  const digits = digitsOnly(value);
  const expected = brand === "amex" ? 4 : 3;
  if (digits.length === 0) return "Enter the security code.";
  if (digits.length !== expected) {
    return brand === "amex"
      ? "American Express security codes have 4 digits (on the front)."
      : "The security code is the 3 digits on the back of your card.";
  }
  return null;
}

export function validateCardholderName(value: string): string | null {
  const name = value.trim();
  if (name.length === 0) return "Enter the name on your card.";
  if (name.length > 100) return "Keep the name to 100 characters or fewer.";
  return null;
}

export interface CardForm {
  cardNumber: string;
  expiry: string;
  cvc: string;
  nameOnCard: string;
}

export type CardFormErrors = Partial<Record<keyof CardForm, string>>;

export function validateCardForm(form: CardForm, now = new Date()): CardFormErrors {
  const brand = detectCardBrand(digitsOnly(form.cardNumber));
  const errors: CardFormErrors = {};
  const number = validateCardNumber(form.cardNumber);
  if (number) errors.cardNumber = number;
  const expiry = validateExpiry(form.expiry, now);
  if (expiry) errors.expiry = expiry;
  const cvc = validateCvc(form.cvc, brand);
  if (cvc) errors.cvc = cvc;
  const name = validateCardholderName(form.nameOnCard);
  if (name) errors.nameOnCard = name;
  return errors;
}

/** The request body's `payment` member. Only call with a form that passed validation. */
export function toCardPayment(form: CardForm) {
  const expiry = parseExpiry(form.expiry);
  if (!expiry) throw new Error("toCardPayment needs a valid expiry");
  return {
    method: "card" as const,
    cardNumber: digitsOnly(form.cardNumber),
    expMonth: expiry.month,
    expYear: expiry.year,
    cvc: digitsOnly(form.cvc),
    nameOnCard: form.nameOnCard.trim(),
  };
}
