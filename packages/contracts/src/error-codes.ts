/**
 * The stable error codes of the API. Zod-free at runtime (see `constants.ts`); the problem
 * document schemas live in `errors.ts`.
 */
interface ErrorSpec {
  readonly status: number;
  readonly title: string;
}

/**
 * Every error the API can return, keyed by its stable machine-readable `code`.
 * Codes are part of the public contract: never rename or repurpose one; add new ones.
 * Clients switch on `code`, never on `status` or `title`.
 */
export const ERROR_CATALOG = {
  bad_request: { status: 400, title: "Malformed request" },
  validation_failed: { status: 400, title: "Request validation failed" },
  unauthenticated: { status: 401, title: "Sign in required" },
  invalid_credentials: { status: 401, title: "Incorrect email or password" },
  subscription_required: { status: 402, title: "An active membership is required" },
  payment_declined: { status: 402, title: "Payment declined" },
  csrf_check_failed: { status: 403, title: "Missing or invalid client header" },
  forbidden: { status: 403, title: "Not allowed" },
  profile_required: { status: 403, title: "Choose a profile first" },
  profile_pin_required: { status: 403, title: "This profile is locked with a PIN" },
  profile_pin_invalid: { status: 403, title: "Incorrect profile PIN" },
  /** A locked profile is its owner's: changing or deleting it needs its PIN or the password. */
  profile_unlock_required: {
    status: 403,
    title: "This profile is locked: enter its PIN or the account password",
  },
  /** The action needs the account password and none was sent (ask for it, then retry). */
  password_required: { status: 403, title: "The account password is required" },
  current_password_invalid: { status: 403, title: "Current password is incorrect" },
  /** Account management needs an active profile without parental controls. */
  unrestricted_profile_required: {
    status: 403,
    title: "Switch to a profile without parental controls",
  },
  /** The shared demo account's sign-in details, membership and profiles cannot be changed. */
  demo_account_protected: { status: 403, title: "The demo account can't be changed" },
  maturity_restricted: { status: 403, title: "Not available on this profile" },
  media_token_invalid: { status: 403, title: "Invalid media token" },
  media_token_expired: { status: 403, title: "Media token expired" },
  /** A rendition taller than the plan allows (the master playlist never lists it). */
  media_quality_restricted: { status: 403, title: "This video quality is not in your plan" },
  not_found: { status: 404, title: "Not found" },
  media_unavailable: { status: 404, title: "This title cannot be played right now" },
  method_not_allowed: { status: 405, title: "Method not allowed" },
  email_already_registered: { status: 409, title: "An account with this email already exists" },
  profile_limit_reached: { status: 409, title: "Profile limit reached" },
  profile_last_remaining: { status: 409, title: "An account needs at least one profile" },
  stream_limit_reached: { status: 409, title: "Too many people are using this account" },
  playback_session_ended: { status: 410, title: "Playback session has ended" },
  payload_too_large: { status: 413, title: "Request body too large" },
  unsupported_media_type: { status: 415, title: "Unsupported content type" },
  range_not_satisfiable: { status: 416, title: "Requested range not satisfiable" },
  rate_limited: { status: 429, title: "Too many requests" },
  internal_error: { status: 500, title: "Something went wrong" },
  service_unavailable: { status: 503, title: "Service temporarily unavailable" },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

// Object.keys loses the key type; the catalog is a non-empty literal, so the tuple cast is sound.
export const ERROR_CODES = Object.keys(ERROR_CATALOG) as [ErrorCode, ...ErrorCode[]];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CATALOG, value);
}

export function errorStatus(code: ErrorCode): number {
  return ERROR_CATALOG[code].status;
}

/** RFC 9457 `type` member for a code. A URN: stable, and not mistaken for a fetchable URL. */
export function problemType(code: ErrorCode): string {
  return `urn:webflix:problem:${code}`;
}
