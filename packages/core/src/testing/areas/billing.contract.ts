import { describe, expect, it } from "vitest";
import type { Repositories } from "../../repositories/ports.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "../harness.ts";

export interface BillingRepositoryHarness extends HarnessBase {
  repos: Repositories;
}

/**
 * Contract of the billing area's repository (`repos.billing`), run against memory, SQLite,
 * PostgreSQL and D1. The billing owner adds a case for every method, as
 * `describeRepositoryContract` does for milestone 1.
 */
export function describeBillingRepositoryContract(
  name: string,
  factory: HarnessFactory<BillingRepositoryHarness>,
): void {
  describe(`BillingRepository contract: ${name}`, () => {
    const h = useHarness(factory);

    it("is composed into the repositories", () => {
      expect(h().repos.billing).toBeTypeOf("object");
    });
  });
}
