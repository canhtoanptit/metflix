import { type AreaPorts, createRepositoryExperiments } from "@webflix/core";
import { MemoryExperiments } from "@webflix/core/memory";
import { createRepositories } from "@webflix/db";
import type { AreaContext } from "./shared.ts";

/**
 * The experiments area's port in the Worker: definitions in D1, read through the isolate's
 * memory and Workers KV (one D1 read per location and minute at most).
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
