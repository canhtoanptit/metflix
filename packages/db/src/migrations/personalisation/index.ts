import type { SchemaMigration } from "../types.ts";
import * as m0005 from "./0005_personalisation.ts";

/**
 * The personalisation area's migrations, oldest first. Add a migration here (a new file, the next free
 * `NNNN_personalisation_<change>` name) and run `pnpm --filter @webflix/db generate` for D1.
 */
export const PERSONALISATION_MIGRATIONS: readonly SchemaMigration[] = [
  { name: "0005_personalisation", source: "personalisation/0005_personalisation.ts", up: m0005.up },
];
