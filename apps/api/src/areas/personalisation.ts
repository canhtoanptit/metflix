import { type AreaPorts, ConfigError } from "@webflix/core";
import { MemoryRecommendationStore } from "@webflix/core/memory";
import { createDatabaseRecommendationStore } from "@webflix/db";
import type { AreaContext } from "./shared.ts";

/**
 * The personalisation area's ports in the Node runtime: the recommendation store on the mode's
 * database (SQLite in dev, PostgreSQL on k8s) and the artefacts the importer reads from the
 * mode's blob store (where the pipeline publishes `recs/current.json`).
 */
export function createPersonalisationPorts(
  context: AreaContext,
): Pick<AreaPorts, "recommendations" | "recommendationArtefacts"> {
  const { recommendationStore } = context.config.core.personalisation;
  switch (recommendationStore) {
    case "memory":
      return {
        recommendations: new MemoryRecommendationStore(),
        recommendationArtefacts: context.blobs,
      };
    case "database":
      return {
        recommendations: createDatabaseRecommendationStore(context.database),
        recommendationArtefacts: context.blobs,
      };
    case "kv":
      throw new ConfigError([
        "WEBFLIX_RECOMMENDATION_STORE=kv: Workers KV exists only on Cloudflare (use database)",
      ]);
  }
}
