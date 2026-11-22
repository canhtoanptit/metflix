/** The database `RecommendationStore` on every Node dialect (SQLite always, Postgres when set). */
import { describeRecommendationStoreContract } from "@webflix/core/testing";
import { describe } from "vitest";
import { createDatabaseRecommendationStore } from "../src/repositories/areas/personalisation.ts";
import { dialectHarnesses } from "./harness.ts";

for (const harness of dialectHarnesses) {
  describe.skipIf(harness.skip)(harness.label, () => {
    describeRecommendationStoreContract(harness.name, async () => {
      const { database, cleanup } = await harness.create();
      return { store: createDatabaseRecommendationStore(database), cleanup };
    });
  });
}
