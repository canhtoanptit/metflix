/** The database `RecommendationStore` on D1, inside workerd (models and neighbours on Cloudflare). */
import { describeRecommendationStoreContract } from "@webflix/core/testing";
import { createDatabaseRecommendationStore } from "../../src/repositories/areas/personalisation.ts";
import { freshD1Database } from "./setup.ts";

describeRecommendationStoreContract("d1", async () => ({
  store: createDatabaseRecommendationStore(await freshD1Database()),
}));
