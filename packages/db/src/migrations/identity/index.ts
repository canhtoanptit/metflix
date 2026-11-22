import type { SchemaMigration } from "../types.ts";
import * as m0002 from "./0002_identity.ts";

/**
 * The identity area's migrations, oldest first. Add a migration here (a new file, the next free
 * `NNNN_identity_<change>` name) and run `pnpm --filter @webflix/db generate` for D1.
 */
export const IDENTITY_MIGRATIONS: readonly SchemaMigration[] = [
  { name: "0002_identity", source: "identity/0002_identity.ts", up: m0002.up },
];
