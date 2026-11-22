import { type AreaConfigInput, type AreaConfigResult, choice, positiveInteger } from "../config.ts";

/** `database` (definitions in the experiments table, cached); `memory` (tests). */
export const EXPERIMENTS_ADAPTERS = ["memory", "database"] as const;

/** Portable experimentation settings (milestone 2 §8.1). Owned by the experiments area. */
export interface ExperimentsAreaConfig {
  experiments: (typeof EXPERIMENTS_ADAPTERS)[number];
  /** A member is "new" to targeting (`audience: new`) this many days after joining. */
  newMemberDays: number;
}

/**
 * Variables: WEBFLIX_EXPERIMENTS (default database: the staff API writes definitions there),
 * WEBFLIX_EXPERIMENTS_NEW_MEMBER_DAYS (default 30).
 */
export function loadExperimentsConfig(
  input: AreaConfigInput,
): AreaConfigResult<ExperimentsAreaConfig> {
  const issues: string[] = [];
  return {
    config: {
      experiments: choice(input, "WEBFLIX_EXPERIMENTS", EXPERIMENTS_ADAPTERS, "database", issues),
      newMemberDays: positiveInteger(input, "WEBFLIX_EXPERIMENTS_NEW_MEMBER_DAYS", 30, issues),
    },
    issues,
  };
}
