import { type AreaPorts, createRepositoryExperiments } from "@webflix/core";
import { MemoryExperiments } from "@webflix/core/memory";
import { createRepositories } from "@webflix/db";
import type { AreaContext } from "./shared.ts";

/**
 * The experiments area's port in the Node runtime: definitions in the experiments table, read
 * through the process memory and the shared cache (Valkey on k8s), as the staff API writes them.
 */
export function createExperimentsPorts(context: AreaContext): Pick<AreaPorts, "experiments"> {
  const { experiments } = context.config.core.experiments;
  if (experiments === "memory") return { experiments: new MemoryExperiments() };
  return {
    experiments: createRepositoryExperiments({
      repository: createRepositories(context.database).experiments,
      cache: context.cache,
      clock: context.clock,
      logger: context.logger,
    }),
  };
}
