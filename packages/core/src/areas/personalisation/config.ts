import { type AreaConfigInput, type AreaConfigResult, choice, positiveInteger } from "../config.ts";

/**
 * `database` (SQLite in dev, PostgreSQL on k8s, D1 everything on Cloudflare); `kv` (Cloudflare:
 * per-profile lists in Workers KV, models and neighbours in D1); `memory` (tests).
 */
export const RECOMMENDATION_STORE_ADAPTERS = ["memory", "database", "kv"] as const;
export const RANKING_POLICIES = ["learned", "rules"] as const;

/** Portable recommendation-serving settings (milestone 2 §7.2). Owned by personalisation. */
export interface PersonalisationAreaConfig {
  recommendationStore: (typeof RECOMMENDATION_STORE_ADAPTERS)[number];
  /** The policy of profiles no experiment assigns: learned candidates where they exist. */
  defaultPolicy: (typeof RANKING_POLICIES)[number];
  /** The experiment whose control variant is the rule engine and other variants learned. */
  experimentKey: string;
  /**
   * Share of sessions (by session and UTC day) whose pages are shown in random order. 0.05 in
   * production; 0 elsewhere unless set, so local suites that assert row order stay
   * deterministic (a page that explores says so in `policy.explore`).
   */
  exploreShare: number;
  /** A store read slower than this is treated as unavailable (the rule engine serves). */
  readTimeoutMs: number;
}

/**
 * Variables: WEBFLIX_RECOMMENDATION_STORE (default database), WEBFLIX_RECS_DEFAULT_POLICY
 * (default learned), WEBFLIX_RECS_EXPERIMENT (default recs.learned-vs-rules),
 * WEBFLIX_RECS_EXPLORE_SHARE (default 0.05 in production, else 0), WEBFLIX_RECS_READ_TIMEOUT_MS
 * (default 250).
 */
export function loadPersonalisationConfig(
  input: AreaConfigInput,
): AreaConfigResult<PersonalisationAreaConfig> {
  const issues: string[] = [];
  const share = input.vars.WEBFLIX_RECS_EXPLORE_SHARE;
  const defaultShare = input.environment === "production" ? 0.05 : 0;
  const exploreShare = share === undefined ? defaultShare : Number(share);
  if (!(Number.isFinite(exploreShare) && exploreShare >= 0 && exploreShare <= 1)) {
    issues.push("WEBFLIX_RECS_EXPLORE_SHARE: expected a number from 0 to 1");
  }
  const experimentKey = input.vars.WEBFLIX_RECS_EXPERIMENT ?? "recs.learned-vs-rules";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(experimentKey)) {
    issues.push("WEBFLIX_RECS_EXPERIMENT: expected an experiment key");
  }
  return {
    config: {
      recommendationStore: choice(
        input,
        "WEBFLIX_RECOMMENDATION_STORE",
        RECOMMENDATION_STORE_ADAPTERS,
        "database",
        issues,
      ),
      defaultPolicy: choice(
        input,
        "WEBFLIX_RECS_DEFAULT_POLICY",
        RANKING_POLICIES,
        "learned",
        issues,
      ),
      experimentKey,
      exploreShare: Number.isFinite(exploreShare)
        ? Math.min(1, Math.max(0, exploreShare))
        : defaultShare,
      readTimeoutMs: positiveInteger(input, "WEBFLIX_RECS_READ_TIMEOUT_MS", 250, issues),
    },
    issues,
  };
}
