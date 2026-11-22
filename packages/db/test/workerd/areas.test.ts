/** Milestone 2's area repository suites on D1, inside workerd (each area adds its cases). */
import {
  describeAdminRepositoryContract,
  describeBillingRepositoryContract,
  describeEventsRepositoryContract,
  describeExperimentsRepositoryContract,
  describeIdentityRepositoryContract,
  describePersonalisationRepositoryContract,
} from "@webflix/core/testing";
import { createRepositories } from "../../src/repositories/index.ts";
import { freshD1Database } from "./setup.ts";

for (const describeArea of [
  describeIdentityRepositoryContract,
  describeBillingRepositoryContract,
  describeEventsRepositoryContract,
  describePersonalisationRepositoryContract,
  describeExperimentsRepositoryContract,
  describeAdminRepositoryContract,
]) {
  describeArea("d1", async () => ({ repos: createRepositories(await freshD1Database()) }));
}
