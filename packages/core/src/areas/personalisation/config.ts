import { type AreaConfigInput, type AreaConfigResult, choice } from "../config.ts";

/** `memory`; `database` (SQLite, PostgreSQL, D1); `kv` (per-profile lists in Workers KV). */
export const RECOMMENDATION_STORE_ADAPTERS = ["memory", "database", "kv"] as const;

/** Portable recommendation-serving settings (milestone 2 §7.2). Owned by personalisation. */
export interface PersonalisationAreaConfig {
  recommendationStore: (typeof RECOMMENDATION_STORE_ADAPTERS)[number];
}

/** Variables: WEBFLIX_RECOMMENDATION_STORE (default memory). */
export function loadPersonalisationConfig(
  input: AreaConfigInput,
): AreaConfigResult<PersonalisationAreaConfig> {
  const issues: string[] = [];
  return {
    config: {
      recommendationStore: choice(
        input,
        "WEBFLIX_RECOMMENDATION_STORE",
        RECOMMENDATION_STORE_ADAPTERS,
        "memory",
        issues,
      ),
    },
    issues,
  };
}
