/**
 * Repository port of the billing area: `memberships`, `billing_customers`, `billing_operations`, `provider_events`, `trial_fingerprints`, `invoices`, `refunds`, `plan_prices`, `provider_prices`, `checkouts`, `payment_method_setups` and the fake provider's `payments_fake_*` tables (migrations under `packages/db/src/migrations/billing/`).
 *
 * Empty until the billing owner adds methods (then make it an interface). Implemented in memory by
 * `packages/core/src/memory/areas/billing.ts` and on every dialect by
 * `packages/db/src/repositories/areas/billing.ts`; both pass
 * `describeBillingRepositoryContract` (`packages/core/src/testing/areas/billing.contract.ts`).
 * The D1 rules hold: one method per atomic write (one batch), at most 100 bound parameters per
 * statement, hot reads in one round trip.
 */
export type BillingRepository = Record<never, never>;
