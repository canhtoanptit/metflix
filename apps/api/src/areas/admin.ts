import { type AreaPorts, createOidcStaffVerifier, type StaffIssuerFetch } from "@webflix/core";
import { MemoryStaffVerifier } from "@webflix/core/memory";
import { developmentIssuerOf } from "./identity.ts";
import type { AreaContext } from "./shared.ts";

/**
 * The admin area's port in the Node runtime: the staff verifier.
 *
 * - `oidc` (default outside production): access tokens validated offline against the staff
 *   issuer's published keys. Keycloak on Kubernetes is configuration only
 *   (`WEBFLIX_STAFF_ISSUER=https://…/realms/webflix`); unset outside production, the issuer is
 *   the development issuer's `staff` realm mounted at `/dev-idp/staff`, whose discovery and keys
 *   are read in process (it is the same issuer the browser signs in with).
 * - `memory` (default in production until an issuer is configured): tokens can only be minted in
 *   process, so the staff API admits nobody (logged at start).
 */
export function createAdminPorts(context: AreaContext): Pick<AreaPorts, "staff"> {
  const { config, clock, logger } = context;
  const { admin, environment, publicOrigin } = config.core;
  if (admin.staffVerifier === "memory") {
    if (environment === "production") {
      logger.warn("admin.staff_api_closed", {
        detail: "WEBFLIX_STAFF_VERIFIER=memory: no staff token from outside this process verifies",
      });
    }
    return {
      staff: new MemoryStaffVerifier({
        clock,
        audience: admin.staffAudience,
        ...(admin.staffIssuer ? { issuer: admin.staffIssuer } : {}),
      }),
    };
  }
  const development = `${publicOrigin}/dev-idp/staff`;
  const issuer = admin.staffIssuer ?? development;
  // The development issuer is served by this process (identity's composition runs first).
  const host = issuer === development ? developmentIssuerOf(config) : undefined;
  const inProcess: StaffIssuerFetch | undefined = host
    ? (request) => host.fetch(request)
    : undefined;
  return {
    staff: createOidcStaffVerifier({
      issuer,
      audience: admin.staffAudience,
      clientId: admin.staffClientId,
      algorithms: admin.staffAlgorithms,
      clock,
      allowHttp: environment !== "production",
      ...(inProcess ? { fetch: inProcess } : {}),
    }),
  };
}
