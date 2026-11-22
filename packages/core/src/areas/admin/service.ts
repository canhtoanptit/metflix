import { AppError } from "../../errors.ts";
import { type StaffIdentity, StaffTokenError } from "../../ports/staff-verifier.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import { type AreaModule, type AreaSeams, NO_JOBS } from "../module.ts";

/**
 * The admin area (milestone 2 §8.3): staff authentication (`deps.staff`), the audit log
 * (`audit_log`, written in the same batch as each change by the owning area's repository),
 * dead letters with replay, system health, and the admin API's handlers, which call the
 * services of the area that owns the data.
 */
export interface AdminService extends AreaModule {
  /**
   * The staff identity of a bearer token, or `unauthenticated` (the HTTP guard of
   * `auth: "staff"` routes calls it; the role check is the guard's).
   */
  authenticateStaff(token: string): Promise<StaffIdentity>;
}

export function createAdminService(deps: ServiceDependencies, _seams: AreaSeams): AdminService {
  return {
    ...NO_JOBS,
    async authenticateStaff(token) {
      try {
        return await deps.staff.verify(token);
      } catch (error) {
        if (error instanceof StaffTokenError && error.reason === "unavailable") {
          throw new AppError("service_unavailable", { cause: error });
        }
        if (error instanceof StaffTokenError) {
          throw new AppError("unauthenticated", { detail: "Sign in to the staff console again" });
        }
        throw error;
      }
    },
  };
}
