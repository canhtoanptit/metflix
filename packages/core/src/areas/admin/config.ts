import { STAFF_API_AUDIENCE, STAFF_CLIENT_ID } from "@webflix/contracts";
import { type AreaConfigInput, type AreaConfigResult, choice } from "../config.ts";

/** `memory`; `oidc` (offline JWT validation against the staff issuer's JWKS). */
export const STAFF_VERIFIER_ADAPTERS = ["memory", "oidc"] as const;

/** Portable staff-console settings (milestone 2 §8.3). Owned by the admin area. */
export interface AdminAreaConfig {
  staffVerifier: (typeof STAFF_VERIFIER_ADAPTERS)[number];
  /** The staff issuer (Keycloak realm, development issuer's `staff` realm); null: none yet. */
  staffIssuer: string | null;
  staffAudience: string;
  staffClientId: string;
}

/**
 * Variables: WEBFLIX_STAFF_VERIFIER (default memory), WEBFLIX_STAFF_ISSUER (URL; required for
 * `oidc`), WEBFLIX_STAFF_AUDIENCE (default webflix-admin-api), WEBFLIX_STAFF_CLIENT_ID (default
 * webflix-admin).
 */
export function loadAdminConfig(input: AreaConfigInput): AreaConfigResult<AdminAreaConfig> {
  const issues: string[] = [];
  const staffVerifier = choice(
    input,
    "WEBFLIX_STAFF_VERIFIER",
    STAFF_VERIFIER_ADAPTERS,
    "memory",
    issues,
  );
  const issuer = input.vars.WEBFLIX_STAFF_ISSUER ?? null;
  if (issuer !== null && !URL.canParse(issuer)) issues.push("WEBFLIX_STAFF_ISSUER: expected a URL");
  if (issuer === null && staffVerifier === "oidc") {
    issues.push("WEBFLIX_STAFF_VERIFIER=oidc: WEBFLIX_STAFF_ISSUER is required");
  }
  return {
    config: {
      staffVerifier,
      staffIssuer: issuer,
      staffAudience: input.vars.WEBFLIX_STAFF_AUDIENCE ?? STAFF_API_AUDIENCE,
      staffClientId: input.vars.WEBFLIX_STAFF_CLIENT_ID ?? STAFF_CLIENT_ID,
    },
    issues,
  };
}
