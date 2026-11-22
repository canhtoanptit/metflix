import type { PaymentFailureCode, PaymentTestCard } from "@webflix/core";

/**
 * The fake provider's test cards: the five the port's contract suite pays with
 * (`PAYMENT_TEST_CARDS`) plus every other outcome a real provider produces. Each has the number
 * Stripe documents for the same behaviour, so the fake's form accepts what people already type
 * in Stripe's test mode (docs/STRIPE.md §6). No real card number is ever accepted: anything not
 * listed here is refused.
 */
export const FAKE_TEST_CARDS = [
  "visa",
  "mastercard",
  "declined",
  "insufficient-funds",
  "expired-card",
  "incorrect-cvc",
  "processing-error",
  "lost-card",
  "charge-declined",
  "authentication-required",
  "challenge",
] as const satisfies readonly (PaymentTestCard | string)[];
export type FakeTestCard = (typeof FAKE_TEST_CARDS)[number];

export interface FakeCardSpec {
  number: string;
  brand: "visa" | "mastercard";
  label: string;
  /** Refused when the card is confirmed (setup or on-session payment). */
  declineAtConfirm: PaymentFailureCode | null;
  /** Refused when charged off-session later (renewals, prorations, explicit attempts). */
  declineOffSession: PaymentFailureCode | null;
  /** A challenge (3-D Secure) must be completed in the form before it is confirmed. */
  challenge: boolean;
}

export const FAKE_CARDS: Record<FakeTestCard, FakeCardSpec> = {
  visa: card("4242424242424242", "visa", "Succeeds"),
  mastercard: card(
    "5555555555554444",
    "mastercard",
    "Succeeds (a second card, another fingerprint)",
  ),
  declined: card("4000000000000002", "visa", "Declined (generic)", "card_declined"),
  "insufficient-funds": card(
    "4000000000009995",
    "visa",
    "Declined: insufficient funds",
    "insufficient_funds",
  ),
  "expired-card": card("4000000000000069", "visa", "Declined: expired card", "expired_card"),
  "incorrect-cvc": card("4000000000000127", "visa", "Declined: incorrect CVC", "incorrect_cvc"),
  "processing-error": card(
    "4000000000000119",
    "visa",
    "Declined: processing error",
    "processing_error",
  ),
  "lost-card": card("4000000000009987", "visa", "Declined: lost card", "card_declined"),
  "charge-declined": {
    ...card("4000000000000341", "visa", "Saved fine, declined when charged later"),
    declineOffSession: "card_declined",
  },
  "authentication-required": {
    ...card("4000002760003184", "visa", "Always asks for a challenge, also off-session"),
    challenge: true,
    declineOffSession: "authentication_required",
  },
  challenge: {
    ...card("4000002500003155", "visa", "Asks for a challenge once, then charges off-session"),
    challenge: true,
  },
};

function card(
  number: string,
  brand: "visa" | "mastercard",
  label: string,
  declineAtConfirm: PaymentFailureCode | null = null,
): FakeCardSpec {
  return {
    number,
    brand,
    label,
    declineAtConfirm,
    declineOffSession: declineAtConfirm,
    challenge: false,
  };
}

/** A test card by name or by its number (spaces and dashes ignored); null for anything else. */
export function resolveTestCard(input: string): FakeTestCard | null {
  const value = input.trim().toLowerCase();
  if ((FAKE_TEST_CARDS as readonly string[]).includes(value)) return value as FakeTestCard;
  const digits = value.replaceAll(/[\s-]/g, "");
  for (const name of FAKE_TEST_CARDS) {
    if (FAKE_CARDS[name].number === digits) return name;
  }
  return null;
}

/**
 * A card as chosen in the form: a test card (by name or number), optionally followed by
 * `:<label>` to mean *another card of that kind* (`visa:run-42`): it behaves exactly like the
 * test card but has its own fingerprint, so a suite can get a card that never had a trial, as
 * often as it likes. The same label is the same card again (no second trial).
 */
export type FakeCardChoice = FakeTestCard | `${FakeTestCard}:${string}`;

const LABEL = /^[A-Za-z0-9_.-]{1,64}$/;

/** A card choice as typed (`visa`, `4242 4242 4242 4242`, `visa:run-42`); null if not one. */
export function parseCardChoice(
  input: string,
): { card: FakeTestCard; label: string | null; choice: FakeCardChoice } | null {
  const [base = "", label, ...rest] = input.trim().split(":");
  if (rest.length > 0) return null;
  const card = resolveTestCard(base);
  if (!card) return null;
  if (label === undefined) return { card, label: null, choice: card };
  if (!LABEL.test(label)) return null;
  return { card, label, choice: `${card}:${label}` };
}

/**
 * The same card has the same fingerprint for every customer (like a real provider); a labelled
 * card (`visa:run-42`) has its own, the same every time that label is used.
 */
export function cardFingerprint(card: FakeTestCard, label: string | null = null): string {
  const base = `fp_fake_${card.replaceAll("-", "_")}`;
  if (label === null) return base;
  // FNV-1a: stable everywhere, no crypto needed for a test double's fingerprint.
  let hash = 0x811c9dc5;
  for (const char of label) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${base}_${hash.toString(16).padStart(8, "0")}${label.length.toString(16)}`;
}
