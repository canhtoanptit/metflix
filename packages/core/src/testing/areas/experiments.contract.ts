import { describe, expect, it } from "vitest";
import type { AuditRecord } from "../../areas/experiments/audit.ts";
import type { Repositories } from "../../repositories/ports.ts";
import { experimentDefinition } from "../experiments.contract.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "../harness.ts";

export interface ExperimentsRepositoryHarness extends HarnessBase {
  repos: Repositories;
  /** Audit rows written so far (optional: the audit assertions run where a runner reads them). */
  auditRows?(): Promise<Pick<AuditRecord, "id" | "action" | "target" | "reason">[]>;
}

function audit(id: string, action: string, key: string): AuditRecord {
  return {
    id,
    actor: { type: "staff", id: "staff-1", name: "Ada" },
    action,
    target: { type: "experiment", id: key },
    before: null,
    after: { key },
    reason: "Pre-registered for the Q4 review",
    requestId: "req-1",
    createdAt: Date.UTC(2026, 10, 22, 12),
  };
}

/**
 * Contract of the experiments area's repository (`repos.experiments`), run against memory,
 * SQLite, PostgreSQL and D1: definitions round-trip exactly, versions guard concurrent staff
 * edits, every write carries its audit row in the same batch (and a write that loses writes no
 * audit row), reports keep the newest.
 */
export function describeExperimentsRepositoryContract(
  name: string,
  factory: HarnessFactory<ExperimentsRepositoryHarness>,
): void {
  describe(`ExperimentsRepository contract: ${name}`, () => {
    const h = useHarness(factory);

    it("creates a definition at version 1 and reads it back exactly", async () => {
      const repo = h().repos.experiments;
      const definition = experimentDefinition({
        description: "Learned candidates against the rule engine",
        endsAt: "2026-12-31T00:00:00.000Z",
        power: null,
        srmThreshold: null,
        registeredAt: null,
        status: "draft",
      });
      expect(
        await repo.createExperiment(definition, audit("a-1", "experiment.create", definition.key)),
      ).toBe(true);
      expect(await repo.getExperiment(definition.key)).toEqual({ definition, version: 1 });
      expect(await repo.listExperiments()).toEqual([{ definition, version: 1 }]);
      expect(await repo.getExperiment("missing")).toBeNull();
    });

    it("refuses a taken key without writing an audit row", async () => {
      const repo = h().repos.experiments;
      const definition = experimentDefinition({ status: "draft" });
      expect(
        await repo.createExperiment(definition, audit("a-1", "experiment.create", definition.key)),
      ).toBe(true);
      expect(
        await repo.createExperiment(
          { ...definition, name: "Another" },
          audit("a-2", "experiment.create", definition.key),
        ),
      ).toBe(false);
      expect((await repo.getExperiment(definition.key))?.definition.name).toBe(definition.name);
      const rows = await h().auditRows?.();
      if (rows) expect(rows.map((row) => row.id)).toEqual(["a-1"]);
    });

    it("updates only from the expected version, with its audit row", async () => {
      const repo = h().repos.experiments;
      const definition = experimentDefinition({ status: "draft" });
      await repo.createExperiment(definition, audit("a-1", "experiment.create", definition.key));
      // A scheduled change round-trips: when it takes effect and what holds until then.
      const running = {
        ...definition,
        status: "running" as const,
        statusChangeAt: "2026-11-22T13:01:00.000Z",
        previousStatus: "draft" as const,
        updatedAt: "2026-11-22T13:00:00.000Z",
      };
      expect(
        await repo.updateExperiment(running, 1, audit("a-2", "experiment.status", definition.key)),
      ).toBe(true);
      expect(await repo.getExperiment(definition.key)).toEqual({ definition: running, version: 2 });
      // A second editor still holding version 1 loses, and leaves no trace.
      const stale = { ...definition, name: "Stale", updatedAt: "2026-11-22T13:00:01.000Z" };
      expect(
        await repo.updateExperiment(stale, 1, audit("a-3", "experiment.update", definition.key)),
      ).toBe(false);
      expect((await repo.getExperiment(definition.key))?.definition.name).toBe(definition.name);
      const rows = await h().auditRows?.();
      if (rows) {
        expect(rows.map((row) => [row.id, row.action, row.target.id, row.reason])).toEqual([
          ["a-1", "experiment.create", definition.key, "Pre-registered for the Q4 review"],
          ["a-2", "experiment.status", definition.key, "Pre-registered for the Q4 review"],
        ]);
      }
    });

    it("keeps reports and returns the newest", async () => {
      const repo = h().repos.experiments;
      expect(await repo.latestResults("recs.learned-vs-rules")).toBeNull();
      await repo.saveResults("recs.learned-vs-rules", {
        computedAt: 2000,
        report: { decision: "flat" },
      });
      await repo.saveResults("recs.learned-vs-rules", {
        computedAt: 1000,
        report: { decision: "old" },
      });
      expect(await repo.latestResults("recs.learned-vs-rules")).toEqual({
        computedAt: 2000,
        report: { decision: "flat" },
      });
      await repo.saveResults("recs.learned-vs-rules", {
        computedAt: 2000,
        report: { decision: "significant", lift: 0.087 },
      });
      expect((await repo.latestResults("recs.learned-vs-rules"))?.report).toEqual({
        decision: "significant",
        lift: 0.087,
      });
    });
  });
}
