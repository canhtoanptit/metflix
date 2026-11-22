/** The personalisation (editorial) repository on every Node dialect, audit rows read back. */
import { describePersonalisationRepositoryContract } from "@webflix/core/testing";
import { describe } from "vitest";
import { createRepositories } from "../src/repositories/index.ts";
import { auditRows } from "./experiments-repository.test.ts";
import { dialectHarnesses } from "./harness.ts";

for (const harness of dialectHarnesses) {
  describe.skipIf(harness.skip)(harness.label, () => {
    describePersonalisationRepositoryContract(`${harness.name} with audit rows`, async () => {
      const { database, cleanup } = await harness.create();
      return { repos: createRepositories(database), auditRows: () => auditRows(database), cleanup };
    });
  });
}
