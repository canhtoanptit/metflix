import type { SchemaMigration } from "../types.ts";
import * as m0007 from "./0007_admin.ts";

/**
 * The admin area's migrations, oldest first. Add a migration here (a new file, the next free
 * `NNNN_admin_<change>` name) and run `pnpm --filter @webflix/db generate` for D1.
 */
export const ADMIN_MIGRATIONS: readonly SchemaMigration[] = [
  { name: "0007_admin", source: "admin/0007_admin.ts", up: m0007.up },
];
