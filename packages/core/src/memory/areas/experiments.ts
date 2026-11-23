import type { ExperimentDefinition } from "@webflix/contracts";
import type { AuditRecord } from "../../areas/experiments/audit.ts";
import type {
  ExperimentReport,
  ExperimentsRepository,
  StoredExperiment,
} from "../../areas/experiments/repository.ts";

/** In-memory `ExperimentsRepository`; `audit` holds the audit rows it was given (tests). */
export interface MemoryExperimentsRepository extends ExperimentsRepository {
  readonly audit: readonly AuditRecord[];
}

export function createMemoryExperimentsRepository(): MemoryExperimentsRepository {
  const experiments = new Map<string, StoredExperiment>();
  const results = new Map<string, ExperimentReport[]>();
  const audit: AuditRecord[] = [];
  const copy = (stored: StoredExperiment): StoredExperiment => structuredClone(stored);

  return {
    audit,
    async listExperiments() {
      return [...experiments.values()]
        .sort((a, b) => (a.definition.key < b.definition.key ? -1 : 1))
        .map(copy);
    },
    async getExperiment(key) {
      const stored = experiments.get(key);
      return stored ? copy(stored) : null;
    },
    async createExperiment(definition: ExperimentDefinition, record) {
      if (experiments.has(definition.key)) return false;
      experiments.set(definition.key, { definition: structuredClone(definition), version: 1 });
      audit.push(structuredClone(record));
      return true;
    },
    async updateExperiment(definition, expectedVersion, record) {
      const stored = experiments.get(definition.key);
      if (!stored || stored.version !== expectedVersion) return false;
      experiments.set(definition.key, {
        definition: structuredClone(definition),
        version: expectedVersion + 1,
      });
      audit.push(structuredClone(record));
      return true;
    },
    async latestResults(key) {
      const reports = results.get(key) ?? [];
      const latest = reports.reduce<ExperimentReport | null>(
        (best, report) => (best === null || report.computedAt > best.computedAt ? report : best),
        null,
      );
      return latest ? structuredClone(latest) : null;
    },
    async saveResults(key, report) {
      const reports = (results.get(key) ?? []).filter(
        (existing) => existing.computedAt !== report.computedAt,
      );
      reports.push(structuredClone(report));
      results.set(key, reports);
    },
    async pruneResults(before, limit) {
      const old = [...results.entries()]
        .flatMap(([key, reports]) => reports.map((report) => ({ key, at: report.computedAt })))
        .filter((entry) => entry.at < before)
        .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1))
        .slice(0, limit);
      for (const { key, at } of old) {
        results.set(
          key,
          (results.get(key) ?? []).filter((report) => report.computedAt !== at),
        );
      }
      return old.length;
    },
  };
}
