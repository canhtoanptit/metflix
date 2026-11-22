/**
 * What the admin area exports from `@webflix/core` (re-exported by the package index, so the
 * area adds exports here without touching the shared index).
 */
export {
  type AuditedAction,
  type AuditTrail,
  auditActor,
  failureOutcome,
  PENDING_AUDIT_TIMEOUT_MS,
  presentAuditEntry,
  type StaffContext,
  staffAction,
} from "./audit.ts";
export { type DeadLetters, JOB_MAX_ATTEMPTS, presentDeadLetter } from "./dead-letters.ts";
export type { StaffOperations } from "./operations.ts";
export type * from "./repository.ts";
export { type AdminServiceOptions, auditSweepJob } from "./service.ts";
export {
  createOidcStaffVerifier,
  type OidcStaffVerifierOptions,
  type StaffIssuerFetch,
} from "./staff-verifier.ts";
