import type { AreaPorts } from "@webflix/core";
import { MemoryExperiments } from "@webflix/core/memory";
import { type AreaContext, notBuiltYet } from "./shared.ts";

/**
 * The experiments area's port in the Worker. Owned by the experiments area: it adds the D1
 * definitions with a KV cache here.
 */
export function createExperimentsPorts(context: AreaContext): Pick<AreaPorts, "experiments"> {
  const { experiments } = context.config.core.experiments;
  if (experiments !== "memory") notBuiltYet("WEBFLIX_EXPERIMENTS", experiments, "experiments");
  return { experiments: new MemoryExperiments() };
}
