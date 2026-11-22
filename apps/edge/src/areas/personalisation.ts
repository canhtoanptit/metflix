import type { AreaPorts } from "@webflix/core";
import { MemoryRecommendationStore } from "@webflix/core/memory";
import { type AreaContext, notBuiltYet } from "./shared.ts";

/**
 * The personalisation area's port in the Worker. Owned by personalisation: it adds the store
 * here (neighbours in D1, per-profile lists in KV: verify KV bulk-write limits first, §9).
 */
export function createPersonalisationPorts(
  context: AreaContext,
): Pick<AreaPorts, "recommendations"> {
  const { recommendationStore } = context.config.core.personalisation;
  if (recommendationStore !== "memory") {
    notBuiltYet("WEBFLIX_RECOMMENDATION_STORE", recommendationStore, "personalisation");
  }
  return { recommendations: new MemoryRecommendationStore() };
}
