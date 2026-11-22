import { type AreaPorts, createOidcStaffVerifier, type StaffIssuerFetch } from "@webflix/core";
import { MemoryStaffVerifier } from "@webflix/core/memory";
import { developmentIssuerOf } from "./identity.ts";
import type { AreaContext } from "./shared.ts";

/**
 * The admin area's port in the Worker: the staff verifier, as in the Node runtime.
 *
 * - `oidc` (default outside production): access tokens validated offline against the configured
 *   staff issuer's published keys (`WEBFLIX_STAFF_ISSUER`; Keycloak or any OpenID issuer), with
 *   Web Crypto. Unset outside production: the development issuer's `staff` realm this Worker
 *   serves at `/dev-idp/staff`, read in process. Each isolate caches the keys on its own.
 * - `memory` (default in production until an issuer is configured): admits nobody.
 */
export function createAdminPorts(context: AreaContext): Pick<AreaPorts, "staff"> {
  const { config, clock, logger, env } = context;
  const { admin, environment, publicOrigin } = config.core;
  if (admin.staffVerifier === "memory") {
    if (environment === "production") {
      logger.warn("admin.staff_api_closed", {
        detail: "WEBFLIX_STAFF_VERIFIER=memory: no staff token from outside this isolate verifies",
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
  // The development issuer is served by this isolate (identity's composition runs first).
  const host = issuer === development ? developmentIssuerOf(env) : undefined;
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
