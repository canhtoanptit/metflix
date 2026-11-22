import { STAFF_CLIENT_ID, STAFF_ROLES, type StaffRole } from "@webflix/contracts";

/**
 * Port: validates a staff access token and maps its roles (milestone 2 §3, §8.3). Development
 * issuer locally, Keycloak on Kubernetes, a configured issuer on Cloudflare; the adapter
 * verifies offline against the issuer's JWKS.
 *
 * Contract (`describeStaffVerifierContract`):
 * - Accepts only a token signed by the issuer, with `iss` equal to it, the admin API's audience
 *   in `aud` (`webflix-admin-api`), unexpired and not issued in the future (small skew), and of
 *   the access-token type: an ID token is not an access token (Keycloak marks them `typ: ID`).
 * - Roles are read from `resource_access["webflix-admin"].roles` only and filtered to
 *   `STAFF_ROLES`: realm roles, other clients' roles and unknown names are ignored. A valid token
 *   without a Webflix role verifies with `roles: []` (the guard then refuses with
 *   `staff_role_required`).
 * - Every rejection is a `StaffTokenError`; staff identity never becomes a member session.
 */
export interface StaffVerifier {
  verify(token: string): Promise<StaffIdentity>;
}

export interface StaffIdentity {
  /** The issuer's subject for this staff member. */
  subject: string;
  name: string | null;
  email: string | null;
  roles: StaffRole[];
  /** Epoch ms when the token expires. */
  expiresAt: number;
}

export const STAFF_TOKEN_FAILURE_REASONS = [
  "malformed",
  "signature",
  "issuer",
  "audience",
  "expired",
  "not_yet_valid",
  "token_type",
  "unavailable",
] as const;
export type StaffTokenFailureReason = (typeof STAFF_TOKEN_FAILURE_REASONS)[number];

export class StaffTokenError extends Error {
  override readonly name = "StaffTokenError";
  readonly reason: StaffTokenFailureReason;

  constructor(reason: StaffTokenFailureReason, message?: string) {
    super(message ?? reason);
    this.reason = reason;
  }
}

/**
 * The Webflix roles of a verified token's claims: `resource_access[clientId].roles` filtered to
 * `STAFF_ROLES`, deduplicated, in catalogue order. Shared by every adapter.
 */
export function mapStaffRoles(
  claims: Readonly<Record<string, unknown>>,
  clientId: string = STAFF_CLIENT_ID,
): StaffRole[] {
  const access = claims.resource_access;
  if (typeof access !== "object" || access === null) return [];
  const client = (access as Record<string, unknown>)[clientId];
  if (typeof client !== "object" || client === null) return [];
  const roles = (client as { roles?: unknown }).roles;
  if (!Array.isArray(roles)) return [];
  return STAFF_ROLES.filter((role) => roles.includes(role));
}

/** True when `identity` may call a route needing `required` (`admin` passes every check). */
export function staffHasRole(identity: StaffIdentity, required: StaffRole | "any"): boolean {
  if (required === "any") return true;
  return identity.roles.includes("admin") || identity.roles.includes(required);
}
