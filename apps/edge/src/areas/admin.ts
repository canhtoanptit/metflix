import type { AreaPorts } from "@webflix/core";
import { MemoryStaffVerifier } from "@webflix/core/memory";
import { type AreaContext, notBuiltYet } from "./shared.ts";

/**
 * The admin area's port in the Worker. Owned by the admin area: it adds the JWKS verifier for the
 * configured staff issuer here.
 */
export function createAdminPorts(context: AreaContext): Pick<AreaPorts, "staff"> {
  const { admin } = context.config.core;
  if (admin.staffVerifier !== "memory") {
    notBuiltYet("WEBFLIX_STAFF_VERIFIER", admin.staffVerifier, "admin");
  }
  return {
    staff: new MemoryStaffVerifier({
      clock: context.clock,
      audience: admin.staffAudience,
      ...(admin.staffIssuer ? { issuer: admin.staffIssuer } : {}),
    }),
  };
}
