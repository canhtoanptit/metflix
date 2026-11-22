/**
 * Repository port of the personalisation area: `recommendation_models`, `recommendation_neighbours`, `recommendation_profiles`, `editorial_billboards`, `editorial_collections`, `editorial_collection_items`, `title_availability` (migrations under `packages/db/src/migrations/personalisation/`).
 *
 * Empty until the personalisation owner adds methods (then make it an interface). Implemented in memory by
 * `packages/core/src/memory/areas/personalisation.ts` and on every dialect by
 * `packages/db/src/repositories/areas/personalisation.ts`; both pass
 * `describePersonalisationRepositoryContract` (`packages/core/src/testing/areas/personalisation.contract.ts`).
 * The D1 rules hold: one method per atomic write (one batch), at most 100 bound parameters per
 * statement, hot reads in one round trip.
 */
export type PersonalisationRepository = Record<never, never>;
