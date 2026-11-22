import { describe, expect, it } from "vitest";
import type { Repositories } from "../../repositories/ports.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "../harness.ts";

export interface EventsRepositoryHarness extends HarnessBase {
  repos: Repositories;
}

/**
 * Contract of the events area's repository (`repos.events`), run against memory, SQLite,
 * PostgreSQL and D1. The events owner adds a case for every method, as
 * `describeRepositoryContract` does for milestone 1.
 */
export function describeEventsRepositoryContract(
  name: string,
  factory: HarnessFactory<EventsRepositoryHarness>,
): void {
  describe(`EventsRepository contract: ${name}`, () => {
    const h = useHarness(factory);

    it("is composed into the repositories", () => {
      expect(h().repos.events).toBeTypeOf("object");
    });
  });
}
