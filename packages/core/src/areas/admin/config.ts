import { STAFF_API_AUDIENCE, STAFF_CLIENT_ID } from "@webflix/contracts";
import { type AreaConfigInput, type AreaConfigResult, choice, positiveInteger } from "../config.ts";
import { ID_TOKEN_ALGORITHMS, type IdTokenAlgorithm } from "../identity/jose.ts";

/** `memory` (tokens mintable only in process: nobody else gets in); `oidc` (the staff issuer). */
export const STAFF_VERIFIER_ADAPTERS = ["memory", "oidc"] as const;

/** Portable staff-console settings (milestone 2 §8.3). Owned by the admin area. */
export interface AdminAreaConfig {
  staffVerifier: (typeof STAFF_VERIFIER_ADAPTERS)[number];
  /**
   * The staff issuer (a Keycloak realm, the development issuer's `staff` realm); null: unset,
   * which outside production means the development issuer at `{publicOrigin}/dev-idp/staff`
   * (resolved by each runtime's composition, which knows the origin).
   */
  staffIssuer: string | null;
  staffAudience: string;
  staffClientId: string;
  /** Signature algorithms accepted on staff tokens, fixed here and never read from a token. */
  staffAlgorithms: IdTokenAlgorithm[];
  /** Audit entries older than this are deleted by the scheduled sweep (days). */
  auditRetentionDays: number;
}

/**
 * 396 days (13 months): a year of staff activity for investigations (the payment industry asks
 * for twelve months of audit trail), a month of margin, and the same period as raw events, so no
 * record of staff access to a member outlives the member's own activity by much.
 */
export const DEFAULT_AUDIT_RETENTION_DAYS = 396;

/**
 * Variables: WEBFLIX_STAFF_VERIFIER (default `oidc` outside production, against the development
 * issuer; `memory` in production, which admits nobody until a staff issuer is configured),
 * WEBFLIX_STAFF_ISSUER (URL; required for `oidc` in production), WEBFLIX_STAFF_AUDIENCE (default
 * webflix-admin-api), WEBFLIX_STAFF_CLIENT_ID (default webflix-admin), WEBFLIX_STAFF_ALGORITHMS
 * (comma-separated RS256 and/or ES256; default RS256, Keycloak's default),
 * WEBFLIX_AUDIT_RETENTION_DAYS (default 396: `DEFAULT_AUDIT_RETENTION_DAYS`).
 */
export function loadAdminConfig(input: AreaConfigInput): AreaConfigResult<AdminAreaConfig> {
  const issues: string[] = [];
  const production = input.environment === "production";
  const staffVerifier = choice(
    input,
    "WEBFLIX_STAFF_VERIFIER",
    STAFF_VERIFIER_ADAPTERS,
    production ? "memory" : "oidc",
    issues,
  );
  const issuer = input.vars.WEBFLIX_STAFF_ISSUER ?? null;
  if (issuer !== null) {
    if (!URL.canParse(issuer)) issues.push("WEBFLIX_STAFF_ISSUER: expected a URL");
    else {
      const url = new URL(issuer);
      if (issuer.endsWith("/") || url.search !== "" || url.hash !== "") {
        issues.push("WEBFLIX_STAFF_ISSUER: the exact issuer, without a trailing slash");
      } else if (production && url.protocol !== "https:") {
        issues.push("WEBFLIX_STAFF_ISSUER: must be https in production");
      }
    }
  }
  if (issuer === null && staffVerifier === "oidc" && production) {
    issues.push("WEBFLIX_STAFF_VERIFIER=oidc: WEBFLIX_STAFF_ISSUER is required in production");
  }
  const algorithms: IdTokenAlgorithm[] = [];
  for (const name of (input.vars.WEBFLIX_STAFF_ALGORITHMS ?? "RS256").split(",")) {
    const trimmed = name.trim();
    if ((ID_TOKEN_ALGORITHMS as readonly string[]).includes(trimmed)) {
      if (!algorithms.includes(trimmed as IdTokenAlgorithm)) {
        algorithms.push(trimmed as IdTokenAlgorithm);
      }
    } else {
      issues.push(`WEBFLIX_STAFF_ALGORITHMS: expected RS256 and/or ES256, got "${trimmed}"`);
    }
  }
  const auditRetentionDays = positiveInteger(
    input,
    "WEBFLIX_AUDIT_RETENTION_DAYS",
    DEFAULT_AUDIT_RETENTION_DAYS,
    issues,
  );
  return {
    config: {
      staffVerifier,
      staffIssuer: issuer,
      staffAudience: input.vars.WEBFLIX_STAFF_AUDIENCE ?? STAFF_API_AUDIENCE,
      staffClientId: input.vars.WEBFLIX_STAFF_CLIENT_ID ?? STAFF_CLIENT_ID,
      staffAlgorithms: algorithms.length > 0 ? algorithms : ["RS256"],
      auditRetentionDays,
    },
    issues,
  };
}
