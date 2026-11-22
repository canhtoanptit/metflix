/**
 * Client-side validation for the member forms. Mirrors the contract's rules (`EmailAddress`,
 * `Password`, `ProfileName`) without importing zod, so the auth and sign-up
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
