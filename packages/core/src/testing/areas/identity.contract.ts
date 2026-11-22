import { describe, expect, it } from "vitest";
import type { Repositories } from "../../repositories/ports.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "../harness.ts";

export interface IdentityRepositoryHarness extends HarnessBase {
  repos: Repositories;
}

/**
 * Contract of the identity area's repository (`repos.identity`), run against memory, SQLite,
 * PostgreSQL and D1. The identity owner adds a case for every method, as
 * `describeRepositoryContract` does for milestone 1.
 */
export function describeIdentityRepositoryContract(
  name: string,
  factory: HarnessFactory<IdentityRepositoryHarness>,
): void {
  describe(`IdentityRepository contract: ${name}`, () => {
    const h = useHarness(factory);

    it("is composed into the repositories", () => {
      expect(h().repos.identity).toBeTypeOf("object");
    });
  });
}
