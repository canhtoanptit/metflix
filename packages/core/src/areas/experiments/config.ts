import { type AreaConfigInput, type AreaConfigResult, choice, positiveInteger } from "../config.ts";

/** `database` (definitions in the experiments table, cached); `memory` (tests). */
export const EXPERIMENTS_ADAPTERS = ["memory", "database"] as const;

/** Portable experimentation settings (milestone 2 §8.1). Owned by the experiments area. */
export interface ExperimentsAreaConfig {
  experiments: (typeof EXPERIMENTS_ADAPTERS)[number];
  /** A member is "new" to targeting (`audience: new`) this many days after joining. */
  newMemberDays: number;
  /**
   * How far ahead a status change takes effect, so that every instance's cached definitions
   * agree from that instant (finding K4): longer than any copy of the definitions is used (30 s
   * from its database read, `DEFINITIONS_MAX_AGE_MS`), with room for clock skew. 0 in dev (one
   * process, whose own copy the change refreshes); 60 s on k8s and Cloudflare.
   */
  propagationSec: number;
}

const DEFAULT_PROPAGATION_SEC: Record<string, number> = { dev: 0, k8s: 60, cloudflare: 60 };

/**
 * Variables: WEBFLIX_EXPERIMENTS (default database: the staff API writes definitions there),
 * WEBFLIX_EXPERIMENTS_NEW_MEMBER_DAYS (default 30), WEBFLIX_EXPERIMENTS_PROPAGATION_SEC (default by
 * mode: dev 0, k8s and cloudflare 60).
 */
export function loadExperimentsConfig(
  input: AreaConfigInput,
): AreaConfigResult<ExperimentsAreaConfig> {
  const issues: string[] = [];
  return {
    config: {
      experiments: choice(input, "WEBFLIX_EXPERIMENTS", EXPERIMENTS_ADAPTERS, "database", issues),
      newMemberDays: positiveInteger(input, "WEBFLIX_EXPERIMENTS_NEW_MEMBER_DAYS", 30, issues),
      propagationSec: propagation(input, issues),
    },
    issues,
  };
}

function propagation(input: AreaConfigInput, issues: string[]): number {
  const fallback = DEFAULT_PROPAGATION_SEC[input.vars.WEBFLIX_MODE ?? "dev"] ?? 60;
  const value = input.vars.WEBFLIX_EXPERIMENTS_PROPAGATION_SEC;
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 3600) return parsed;
  issues.push("WEBFLIX_EXPERIMENTS_PROPAGATION_SEC: expected whole seconds from 0 to 3600");
  return fallback;
}
