import type { AreaPorts } from "@webflix/core";
import { MemoryRecommendationStore } from "@webflix/core/memory";
import { type AreaContext, notBuiltYet } from "./shared.ts";

/**
 * The personalisation area's port in the Node runtime. Owned by personalisation: it adds the
 * database store (SQLite in dev, PostgreSQL on k8s) here.
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
