import type { BillingRepository } from "../../areas/billing/repository.ts";

/** In-memory `BillingRepository`: the billing area fills it in with its methods. */
export function createMemoryBillingRepository(): BillingRepository {
  return {};
}
