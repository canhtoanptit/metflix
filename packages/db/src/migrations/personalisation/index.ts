import type { SchemaMigration } from "../types.ts";
import * as m0005 from "./0005_personalisation.ts";
import * as m0009 from "./0009_personalisation_lists.ts";
import * as m0025 from "./0025_personalisation_withdrawals.ts";

/**
 * The personalisation area's migrations, oldest first. Add a migration here (a new file, the next free
 * `NNNN_personalisation_<change>` name) and run `pnpm --filter @webflix/db generate` for D1.
 */
export const PERSONALISATION_MIGRATIONS: readonly SchemaMigration[] = [
  { name: "0005_personalisation", source: "personalisation/0005_personalisation.ts", up: m0005.up },
  {
    name: "0009_personalisation_lists",
    source: "personalisation/0009_personalisation_lists.ts",
    up: m0009.up,
  },
  {
    name: "0025_personalisation_withdrawals",
    source: "personalisation/0025_personalisation_withdrawals.ts",
    up: m0025.up,
  },
];
