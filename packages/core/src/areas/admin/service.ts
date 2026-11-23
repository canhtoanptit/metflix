import * as z from "zod";
import { AppError } from "../../errors.ts";
import { defineJob, handleJob, type JobProcessor } from "../../ports/job-queue.ts";
import { type StaffIdentity, StaffTokenError } from "../../ports/staff-verifier.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import type { AreaServices } from "../index.ts";
import type { AreaModule, AreaSeams } from "../module.ts";
import { createAuditTrail } from "./audit.ts";
import { createDeadLetters, JOB_MAX_ATTEMPTS } from "./dead-letters.ts";
import { createMemberData } from "./member-data.ts";
import { createStaffOperations, type StaffOperations } from "./operations.ts";

/**
 * Every scheduler tick: audit entries nobody settled become `unknown`, and entries older than
 * the retention period are deleted (a bounded batch per tick).
 */
export const auditSweepJob = defineJob("admin.audit-sweep", z.object({}));

/**
 * The admin area (milestone 2 §8.3): staff authentication (`deps.staff`), the audit log
 * (audit.ts), dead letters with replay (dead-letters.ts), system health, and the staff
 * operations the admin API's handlers call (operations.ts), each a call into the service of the
 * area that owns the data.
 */
export interface AdminService extends AreaModule, StaffOperations {
  /**
   * The staff identity of a bearer token, or `unauthenticated` (`service_unavailable` when the
   * staff issuer cannot be reached and no key is cached). The HTTP guard of `auth: "staff"`
   * routes calls it; the role check is the guard's.
   */
  authenticateStaff(token: string): Promise<StaffIdentity>;
  /** The job processor, also recording jobs that exhaust their attempts (services/index.ts). */
  captureDeadLetters(processor: JobProcessor, maxAttempts?: number): JobProcessor;
}

export interface AdminServiceOptions {
  /** The other areas' services, resolved at call time (they are built alongside this one). */
  areas: () => AreaServices;
}

export function createAdminService(
  deps: ServiceDependencies,
  _seams: AreaSeams,
  options: AdminServiceOptions,
): AdminService {
  const trail = createAuditTrail(deps);
  const deadLetters = createDeadLetters(deps);
  const operations = createStaffOperations(deps, options.areas, trail, deadLetters);
  const memberData = createMemberData(deps, options.areas);
  return {
    ...operations,
    // A member's rights (privacy review M5, M6): run by the events area's erasure and export.
    eraseAccountData: memberData.eraseAccountData,
    exportAccountData: memberData.exportAccountData,
    jobs: [
      handleJob(auditSweepJob, async () => {
        await trail.sweepPendingAudit();
        await trail.enforceRetention();
      }),
    ],
    scheduled: () => [auditSweepJob.create({})],

    async authenticateStaff(token) {
      try {
        return await deps.staff.verify(token);
      } catch (error) {
        if (error instanceof StaffTokenError && error.reason === "unavailable") {
          deps.logger.warn("admin.staff_issuer_unavailable", { detail: error.message });
          throw new AppError("service_unavailable", { cause: error });
        }
        if (error instanceof StaffTokenError) {
          // The reason is for the logs only: the caller learns nothing about why.
          deps.logger.info("admin.staff_token_refused", {
            reason: error.reason,
            detail: error.message,
          });
          throw new AppError("unauthenticated", { detail: "Sign in to the staff console again" });
        }
        throw error;
      }
    },

    captureDeadLetters: (processor, maxAttempts = JOB_MAX_ATTEMPTS) =>
      deadLetters.capture(processor, maxAttempts),
  };
}
