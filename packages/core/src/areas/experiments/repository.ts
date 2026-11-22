/**
 * Repository port of the experiments area: `experiments`, `experiment_results` (migrations under `packages/db/src/migrations/experiments/`).
 *
 * Empty until the experiments owner adds methods (then make it an interface). Implemented in memory by
 * `packages/core/src/memory/areas/experiments.ts` and on every dialect by
 * `packages/db/src/repositories/areas/experiments.ts`; both pass
 * `describeExperimentsRepositoryContract` (`packages/core/src/testing/areas/experiments.contract.ts`).
 * The D1 rules hold: one method per atomic write (one batch), at most 100 bound parameters per
 * statement, hot reads in one round trip.
 */
export type ExperimentsRepository = Record<never, never>;
