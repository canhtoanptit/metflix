import type { SchemaMigration } from "../types.ts";
import * as m0004 from "./0004_events.ts";
import * as m0011 from "./0011_events_privacy_open.ts";
import * as m0012 from "./0012_events_outbox.ts";
import * as m0013 from "./0013_events_playback_expiry.ts";
import * as m0016 from "./0016_events_erasure_scope.ts";
import * as m0020 from "./0020_events_deletion_membership.ts";

/**
 * The events area's migrations, oldest first. Add a migration here (a new file, the next free
 * `NNNN_events_<change>` name) and run `pnpm --filter @webflix/db generate` for D1.
 */
export const EVENTS_MIGRATIONS: readonly SchemaMigration[] = [
  { name: "0004_events", source: "events/0004_events.ts", up: m0004.up },
  {
    name: "0011_events_privacy_open",
    source: "events/0011_events_privacy_open.ts",
    up: m0011.up,
  },
  { name: "0012_events_outbox", source: "events/0012_events_outbox.ts", up: m0012.up },
  {
    name: "0013_events_playback_expiry",
    source: "events/0013_events_playback_expiry.ts",
    up: m0013.up,
  },
  {
    name: "0016_events_erasure_scope",
    source: "events/0016_events_erasure_scope.ts",
    up: m0016.up,
  },
  {
    name: "0020_events_deletion_membership",
    source: "events/0020_events_deletion_membership.ts",
    up: m0020.up,
  },
];
