import type { SchemaMigration } from "../types.ts";
import * as m0002 from "./0002_identity.ts";
import * as m0010 from "./0010_identity_claims.ts";
import * as m0015 from "./0015_identity_removals.ts";
import * as m0022 from "./0022_identity_access_proven.ts";

/**
 * The identity area's migrations, oldest first. Add a migration here (a new file, the next free
 * `NNNN_identity_<change>` name) and run `pnpm --filter @webflix/db generate` for D1.
 */
export const IDENTITY_MIGRATIONS: readonly SchemaMigration[] = [
  { name: "0002_identity", source: "identity/0002_identity.ts", up: m0002.up },
  { name: "0010_identity_claims", source: "identity/0010_identity_claims.ts", up: m0010.up },
  { name: "0015_identity_removals", source: "identity/0015_identity_removals.ts", up: m0015.up },
  {
    name: "0022_identity_access_proven",
    source: "identity/0022_identity_access_proven.ts",
    up: m0022.up,
  },
];
