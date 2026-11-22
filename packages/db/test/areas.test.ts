/** Milestone 2's area repository suites on every Node dialect (each area adds its cases). */
import {
  describeAdminRepositoryContract,
  describeBillingRepositoryContract,
  describeEventsRepositoryContract,
  describeExperimentsRepositoryContract,
  describeIdentityRepositoryContract,
  describePersonalisationRepositoryContract,
} from "@webflix/core/testing";
import { describe } from "vitest";
import { createRepositories } from "../src/repositories/index.ts";
import { dialectHarnesses } from "./harness.ts";

for (const harness of dialectHarnesses) {
  describe.skipIf(harness.skip)(harness.label, () => {
    for (const describeArea of [
      describeIdentityRepositoryContract,
      describeBillingRepositoryContract,
      describeEventsRepositoryContract,
      describePersonalisationRepositoryContract,
      describeExperimentsRepositoryContract,
      describeAdminRepositoryContract,
    ]) {
      describeArea(harness.name, async () => {
        const { database, cleanup } = await harness.create();
        return { repos: createRepositories(database), cleanup };
      });
    }
  });
}
