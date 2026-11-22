import type { AreaPorts } from "@webflix/core";
import { MemoryExperiments } from "@webflix/core/memory";
import { type AreaContext, notBuiltYet } from "./shared.ts";

/**
 * The experiments area's port in the Node runtime. Owned by the experiments area: it adds the
 * database-backed definitions here.
 */
export function createExperimentsPorts(context: AreaContext): Pick<AreaPorts, "experiments"> {
  const { experiments } = context.config.core.experiments;
  if (experiments !== "memory") notBuiltYet("WEBFLIX_EXPERIMENTS", experiments, "experiments");
  return { experiments: new MemoryExperiments() };
}
