/**
 * Repository port of the events area: `consents`, `privacy_requests`, `privacy_erasures`, `analytics_daily` (migrations under `packages/db/src/migrations/events/`).
 *
 * Empty until the events owner adds methods (then make it an interface). Implemented in memory by
 * `packages/core/src/memory/areas/events.ts` and on every dialect by
 * `packages/db/src/repositories/areas/events.ts`; both pass
 * `describeEventsRepositoryContract` (`packages/core/src/testing/areas/events.contract.ts`).
 * The D1 rules hold: one method per atomic write (one batch), at most 100 bound parameters per
 * statement, hot reads in one round trip.
 */
export type EventsRepository = Record<never, never>;
