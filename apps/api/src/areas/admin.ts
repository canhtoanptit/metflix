import type { AreaPorts } from "@webflix/core";
import { MemoryStaffVerifier } from "@webflix/core/memory";
import { type AreaContext, notBuiltYet } from "./shared.ts";

/**
 * The admin area's port in the Node runtime. Owned by the admin area: it adds the JWKS verifier
 * for the staff issuer (the development issuer's `staff` realm, Keycloak on k8s) here.
 */
export function createAdminPorts(context: AreaContext): Pick<AreaPorts, "staff"> {
  const { admin } = context.config.core;
  if (admin.staffVerifier !== "memory") {
    notBuiltYet("WEBFLIX_STAFF_VERIFIER", admin.staffVerifier, "admin");
  }
  // In memory, staff tokens can only be minted in process (tests): the staff API answers
  // `unauthenticated` to everyone else until the admin area configures the staff issuer.
  return {
    staff: new MemoryStaffVerifier({
      clock: context.clock,
      audience: admin.staffAudience,
      ...(admin.staffIssuer ? { issuer: admin.staffIssuer } : {}),
    }),
  };
}
