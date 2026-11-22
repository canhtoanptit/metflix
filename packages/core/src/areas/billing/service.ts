import type { ServiceDependencies } from "../../services/context.ts";
import { type AreaModule, type AreaSeams, NO_JOBS } from "../module.ts";

/**
 * The billing area (milestone 2 §5, docs/STRIPE.md): checkout, the membership projection driven
 * by verified provider events (`provider_events`, a job per event that retrieves the current
 * subscription through `deps.payments`), reconciliation, `billing_operations` idempotency,
 * trials, promotions, plan changes with previews, invoices, refunds and catalogue sync. Emits
 * `billing.transition` through `seams.emitServerEvent`. Owns entitlement: playback asks
 * `playbackEntitlement` (services/subscriptions.ts), which this area replaces.
 *
 * Skeleton: the routes of this area answer `not_implemented` until their handlers call methods
 * added here.
 */
export interface BillingService extends AreaModule {}

export function createBillingService(
  _deps: ServiceDependencies,
  _seams: AreaSeams,
): BillingService {
  return { ...NO_JOBS };
}
