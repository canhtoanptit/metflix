import type { SchemaMigration } from "../types.ts";
import * as m0004 from "./0004_events.ts";

/**
 * The events area's migrations, oldest first. Add a migration here (a new file, the next free
 * `NNNN_events_<change>` name) and run `pnpm --filter @webflix/db generate` for D1.
 */
export const EVENTS_MIGRATIONS: readonly SchemaMigration[] = [
  { name: "0004_events", source: "events/0004_events.ts", up: m0004.up },
];
