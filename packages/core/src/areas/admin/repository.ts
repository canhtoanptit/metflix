/**
 * Repository port of the admin area: `audit_log` (written by every area's repository in the same batch as the change it records), `job_dead_letters` (migrations under `packages/db/src/migrations/admin/`).
 *
 * Empty until the admin owner adds methods (then make it an interface). Implemented in memory by
 * `packages/core/src/memory/areas/admin.ts` and on every dialect by
 * `packages/db/src/repositories/areas/admin.ts`; both pass
 * `describeAdminRepositoryContract` (`packages/core/src/testing/areas/admin.contract.ts`).
 * The D1 rules hold: one method per atomic write (one batch), at most 100 bound parameters per
 * statement, hot reads in one round trip.
 */
export type AdminRepository = Record<never, never>;
