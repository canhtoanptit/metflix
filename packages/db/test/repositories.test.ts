import { describeRepositoryContract } from "@webflix/core/testing";
import { describe } from "vitest";
import { createRepositories } from "../src/repositories/index.ts";
import { dialectHarnesses } from "./harness.ts";

// The repository contract on every Node-reachable dialect: a fresh migrated database per test
// (in-memory SQLite; a new Postgres schema when WEBFLIX_TEST_POSTGRES_URL is set).
for (const harness of dialectHarnesses) {
  describe.skipIf(harness.skip)(harness.label, () => {
    describeRepositoryContract(harness.name, async () => {
      const { database, cleanup } = await harness.create();
      return { repos: createRepositories(database), cleanup };
    });
  });
}
