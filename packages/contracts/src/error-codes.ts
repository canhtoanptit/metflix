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

  // --- Milestone 2 (docs/BLUEPRINT-M2.md; docs/CONTRACT_CHANGES.md) ---------------------------
  /**
   * The route is registered, typed and documented but its area has not implemented it yet.
   * Answered before authentication, validation and rate limits, the same way to everyone, so
   * a conformance suite recognises it from one anonymous request (`operationId`, `area`).
   */
  not_implemented: { status: 501, title: "Not implemented yet" },
  /** A sensitive change needs a fresh proof: the password or a fresh sign-in (§4.2). */
  reauthentication_required: { status: 403, title: "Confirm it's you to continue" },
  /** An email link that is unknown, used or expired; deliberately not told apart (§4.3). */
  verification_token_invalid: { status: 400, title: "This link is invalid or has expired" },
  /** The issuer identity belongs to another Webflix account (§4.1). */
  identity_already_linked: {
    status: 409,
    title: "This sign-in is already linked to another account",
  },
  /** Unlinking would leave the account without any way to sign in (§4.1). */
  identity_last_sign_in_method: { status: 409, title: "Keep at least one way to sign in" },
  /** A promo code that cannot be applied, with the reason (§5.4). */
  promotion_code_invalid: { status: 422, title: "This promo code can't be used" },
  /** The payment needs the member's action (3-D Secure): confirm with `clientSecret`. */
  payment_action_required: { status: 402, title: "Confirm the payment to continue" },
  /** A checkout or setup step was called out of order (e.g. confirmed twice). */
  checkout_state_conflict: { status: 409, title: "This checkout can't do that right now" },
  /** A webhook whose signature does not verify over its raw body (§5.3). */
  webhook_signature_invalid: { status: 400, title: "Webhook signature verification failed" },
  /**
   * The deployment has no payment provider (`GET /billing/config` says `none`): a membership
   * cannot be started or paid for here until one is configured. Not a transient outage.
   */
  payments_not_configured: { status: 503, title: "Payments are not set up on this service" },
  /** An export or deletion of this kind is already pending (§6.3). */
  privacy_request_pending: { status: 409, title: "A request like this is already in progress" },
  /**
   * The account's deletion is scheduled (its cooling-off period is running): its membership
   * cannot start renewing again (resume, a new checkout, a plan change) until the member keeps
   * the account (`DELETE /account/deletion`).
   */
  account_deletion_scheduled: { status: 409, title: "This account is being deleted" },
  /** An experiment change that conflicts with its state or its layer's allocation (§8.1). */
  experiment_conflict: { status: 409, title: "That change conflicts with the experiment" },
  /** A valid staff token without the role the route needs (§8.3). */
  staff_role_required: { status: 403, title: "Your staff role does not allow this" },
  /**
   * A staff action that collides with an earlier one: its idempotency key was used for another
   * request, or the earlier attempt with it is still running, failed, or ended with an unknown
   * outcome (the audit entry named in `detail` says which); or a dead letter already replayed.
   */
  staff_action_conflict: { status: 409, title: "This conflicts with an earlier staff action" },
  /**
   * A recommendation run with more per-profile lists than this runtime can write in one
   * invocation (Cloudflare: 1,000 KV operations per Worker invocation, §9); `detail` names the
   * importer that runs outside the Worker. Nothing was imported and the served run is untouched.
   */
  recommendation_import_too_large: {
    status: 422,
    title: "This run is too large to import here",
  },
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
