import { createKvRecommendationStore, createR2BlobStore } from "@webflix/adapters-cloudflare";
import { type AreaPorts, ConfigError } from "@webflix/core";
import { MemoryRecommendationStore } from "@webflix/core/memory";
import { createDatabaseRecommendationStore } from "@webflix/db";
import type { AreaContext } from "./shared.ts";

/**
 * The personalisation area's ports in the Worker: `kv` keeps per-profile lists in Workers KV
 * (`RECS`) and models and neighbours in D1, so a page reads its lists without a D1 round trip;
 * `database` keeps everything in D1. Artefacts are read from R2 directly, never through the
 * media edge cache, which would keep serving an old `recs/current.json`.
 */
export function createPersonalisationPorts(
  context: AreaContext,
): Pick<AreaPorts, "recommendations" | "recommendationArtefacts"> {
  const { recommendationStore } = context.config.core.personalisation;
  const recommendationArtefacts = createR2BlobStore(context.env.MEDIA);
  switch (recommendationStore) {
    case "memory":
      return { recommendations: new MemoryRecommendationStore(), recommendationArtefacts };
    case "database":
      return {
        recommendations: createDatabaseRecommendationStore(context.database),
        recommendationArtefacts,
      };
    case "kv": {
      if (!context.env.RECS) {
        throw new ConfigError([
          "WEBFLIX_RECOMMENDATION_STORE=kv needs the RECS KV namespace binding (wrangler.jsonc)",
        ]);
      }
      return {
        recommendations: createKvRecommendationStore({
          namespace: context.env.RECS,
          base: createDatabaseRecommendationStore(context.database),
        }),
        recommendationArtefacts,
      };
    }
  }
}
