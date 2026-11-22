import { describe, expect, it } from "vitest";
import type { Repositories } from "../../repositories/ports.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "../harness.ts";

export interface ExperimentsRepositoryHarness extends HarnessBase {
  repos: Repositories;
}

/**
 * Contract of the experiments area's repository (`repos.experiments`), run against memory, SQLite,
 * PostgreSQL and D1. The experiments owner adds a case for every method, as
 * `describeRepositoryContract` does for milestone 1.
 */
export function describeExperimentsRepositoryContract(
  name: string,
  factory: HarnessFactory<ExperimentsRepositoryHarness>,
): void {
  describe(`ExperimentsRepository contract: ${name}`, () => {
    const h = useHarness(factory);

    it("is composed into the repositories", () => {
      expect(h().repos.experiments).toBeTypeOf("object");
    });
  });
}
