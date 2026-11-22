import type { SchemaMigration } from "../types.ts";
import * as m0006 from "./0006_experiments.ts";

/**
 * The experiments area's migrations, oldest first. Add a migration here (a new file, the next free
 * `NNNN_experiments_<change>` name) and run `pnpm --filter @webflix/db generate` for D1.
 */
export const EXPERIMENTS_MIGRATIONS: readonly SchemaMigration[] = [
  { name: "0006_experiments", source: "experiments/0006_experiments.ts", up: m0006.up },
];
