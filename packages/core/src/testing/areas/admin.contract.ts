import { describe, expect, it } from "vitest";
import type { Repositories } from "../../repositories/ports.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "../harness.ts";

export interface AdminRepositoryHarness extends HarnessBase {
  repos: Repositories;
}

/**
 * Contract of the admin area's repository (`repos.admin`), run against memory, SQLite,
 * PostgreSQL and D1. The admin owner adds a case for every method, as
 * `describeRepositoryContract` does for milestone 1.
 */
export function describeAdminRepositoryContract(
  name: string,
  factory: HarnessFactory<AdminRepositoryHarness>,
): void {
  describe(`AdminRepository contract: ${name}`, () => {
    const h = useHarness(factory);

    it("is composed into the repositories", () => {
      expect(h().repos.admin).toBeTypeOf("object");
    });
  });
}
