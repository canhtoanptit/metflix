import { describeSearchIndexContract } from "@webflix/core/testing";
import { describe } from "vitest";
import { createSqlSearchIndex } from "../src/search.ts";
import { dialectHarnesses } from "./harness.ts";

for (const harness of dialectHarnesses) {
  describe.skipIf(harness.skip)(harness.label, () => {
    describeSearchIndexContract(
      harness.name === "postgres" ? "Postgres (tsvector)" : "SQLite (FTS5)",
      async () => {
        const { database, cleanup } = await harness.create();
        return { index: createSqlSearchIndex(database), cleanup };
      },
    );
  });
}
