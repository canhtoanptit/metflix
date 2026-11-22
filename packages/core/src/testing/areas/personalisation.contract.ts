import { describe, expect, it } from "vitest";
import type { Repositories } from "../../repositories/ports.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "../harness.ts";

export interface PersonalisationRepositoryHarness extends HarnessBase {
  repos: Repositories;
}

/**
 * Contract of the personalisation area's repository (`repos.personalisation`), run against memory, SQLite,
 * PostgreSQL and D1. The personalisation owner adds a case for every method, as
 * `describeRepositoryContract` does for milestone 1.
 */
export function describePersonalisationRepositoryContract(
  name: string,
  factory: HarnessFactory<PersonalisationRepositoryHarness>,
): void {
  describe(`PersonalisationRepository contract: ${name}`, () => {
    const h = useHarness(factory);

    it("is composed into the repositories", () => {
      expect(h().repos.personalisation).toBeTypeOf("object");
    });
  });
}
