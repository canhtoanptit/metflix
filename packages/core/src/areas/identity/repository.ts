/**
 * Repository port of the identity area: `account_identities`, `account_tokens`, `email_outbox`, `email_suppressions`, and the milestone 2 columns of `accounts` and `sessions` (migrations under `packages/db/src/migrations/identity/`).
 *
 * Empty until the identity owner adds methods (then make it an interface). Implemented in memory by
 * `packages/core/src/memory/areas/identity.ts` and on every dialect by
 * `packages/db/src/repositories/areas/identity.ts`; both pass
 * `describeIdentityRepositoryContract` (`packages/core/src/testing/areas/identity.contract.ts`).
 * The D1 rules hold: one method per atomic write (one batch), at most 100 bound parameters per
 * statement, hot reads in one round trip.
 */
export type IdentityRepository = Record<never, never>;
