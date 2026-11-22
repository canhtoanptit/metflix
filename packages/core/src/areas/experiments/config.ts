import { type AreaConfigInput, type AreaConfigResult, choice } from "../config.ts";

/** `memory`; `database` (definitions in the experiments table, a KV cache on Cloudflare). */
export const EXPERIMENTS_ADAPTERS = ["memory", "database"] as const;

/** Portable experimentation settings (milestone 2 §8.1). Owned by the experiments area. */
export interface ExperimentsAreaConfig {
  experiments: (typeof EXPERIMENTS_ADAPTERS)[number];
}

/** Variables: WEBFLIX_EXPERIMENTS (default memory). */
export function loadExperimentsConfig(
  input: AreaConfigInput,
): AreaConfigResult<ExperimentsAreaConfig> {
  const issues: string[] = [];
  return {
    config: {
      experiments: choice(input, "WEBFLIX_EXPERIMENTS", EXPERIMENTS_ADAPTERS, "memory", issues),
    },
    issues,
  };
}
