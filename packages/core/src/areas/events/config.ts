import { CONSENT_MODES } from "@webflix/contracts";
import {
  type AreaConfigInput,
  type AreaConfigResult,
  choice,
  positiveInteger,
  secret,
} from "../config.ts";

/** `memory` keeps events in process; `lake` writes the event lake to the mode's blob store. */
export const EVENT_SINK_ADAPTERS = ["memory", "lake"] as const;

/**
 * DEVELOPMENT ONLY: the key of the pseudonymous subject keys when WEBFLIX_PSEUDONYM_KEY is unset.
 * Refused in production once events are actually stored (WEBFLIX_EVENT_SINK other than memory).
 */
export const DEV_ONLY_PSEUDONYM_KEY = "dev-only-insecure-pseudonym-key-do-not-deploy";

/**
 * Where the events of a data export come from: `inline` reads the account's events from the
 * lake inside the export job (small deployments: every hour of the retention window in one job
 * invocation); `batch` leaves them to the pipeline's `export-events` job and folds in its
 * result (services/recs README, "Exports of members' events").
 */
export const EXPORT_EVENTS_MODES = ["inline", "batch"] as const;

/** Server events' `app.version` when WEBFLIX_RELEASE is unset. */
export const DEFAULT_SERVER_RELEASE = "dev";
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;

/** Portable behaviour-collection and privacy settings (milestone 2 §6). Owned by the events area. */
export interface EventsAreaConfig {
  eventSink: (typeof EVENT_SINK_ADAPTERS)[number];
  consentMode: (typeof CONSENT_MODES)[number];
  /** HMAC key of the pseudonymous account and profile keys (services/recs README decision 3). */
  pseudonymKey: string;
  rawRetentionDays: number;
  aggregateRetentionDays: number;
  /** A deletion request waits this long before erasure (the member may cancel meanwhile). */
  deletionCoolingOffSec: number;
  /** How long a data export's signed link (and the export itself) stays available. */
  exportLinkTtlSec: number;
  /** `app.version` of server events: the deployed release. */
  serverRelease: string;
  /** Who reads a data export's events: the export job itself, or the pipeline. */
  exportEvents: (typeof EXPORT_EVENTS_MODES)[number];
  /**
   * How long an export normally takes in this deployment, from the request to the email: what
   * members are told before they ask (`PrivacyTerms.exportTypicalSec`).
   */
  exportTypicalSec: number;
}

/**
 * The typical export time per mode when WEBFLIX_EXPORT_TYPICAL_SEC is unset: inline, the next
 * job run (seconds); batch, the pipeline's `export-events` schedule plus its grace (the chart's
 * default: every 5 minutes, 15 minutes' grace).
 */
export const EXPORT_TYPICAL_SEC = { inline: 60, batch: 30 * 60 } as const;

/**
 * Variables: WEBFLIX_EVENT_SINK (default memory), WEBFLIX_CONSENT_MODE (default opt-in),
 * WEBFLIX_PSEUDONYM_KEY (32+ characters), WEBFLIX_EVENTS_RETENTION_DAYS (default 396, 13
 * months), WEBFLIX_AGGREGATES_RETENTION_DAYS (default 1126, 37 months),
 * WEBFLIX_DELETION_COOLING_OFF_SEC (default 1209600, 14 days), WEBFLIX_EXPORT_LINK_TTL_SEC
 * (default 604800, 7 days), WEBFLIX_RELEASE (default `dev`), WEBFLIX_EXPORT_EVENTS (`inline`
 * in dev mode, `batch` otherwise; `inline` refused on Cloudflare), WEBFLIX_EXPORT_TYPICAL_SEC
 * (default 60 inline, 1800 batch).
 */
export function loadEventsConfig(input: AreaConfigInput): AreaConfigResult<EventsAreaConfig> {
  const issues: string[] = [];
  const eventSink = choice(input, "WEBFLIX_EVENT_SINK", EVENT_SINK_ADAPTERS, "memory", issues);
  const key = secret(input, "WEBFLIX_PSEUDONYM_KEY", 32, issues);
  if (!key && input.environment === "production" && eventSink !== "memory") {
    issues.push("WEBFLIX_PSEUDONYM_KEY: required in production once events are stored");
  }
  const release = input.vars.WEBFLIX_RELEASE ?? DEFAULT_SERVER_RELEASE;
  // Inline in dev (one process, a small lake); the pipeline everywhere else. A Worker cannot
  // read 13 months of hourly partitions in one invocation, so Cloudflare refuses inline.
  const mode = input.vars.WEBFLIX_MODE;
  const exportEvents = choice(
    input,
    "WEBFLIX_EXPORT_EVENTS",
    EXPORT_EVENTS_MODES,
    mode === "dev" ? "inline" : "batch",
    issues,
  );
  if (exportEvents === "inline" && mode === "cloudflare") {
    issues.push(
      "WEBFLIX_EXPORT_EVENTS=inline: not on Cloudflare (a Worker cannot read the retention window in one invocation); use batch",
    );
  }
  if (!RELEASE.test(release)) {
    issues.push("WEBFLIX_RELEASE: 1-40 characters of [A-Za-z0-9._+-]");
  }
  return {
    config: {
      eventSink,
      consentMode: choice(input, "WEBFLIX_CONSENT_MODE", CONSENT_MODES, "opt-in", issues),
      pseudonymKey: key ?? DEV_ONLY_PSEUDONYM_KEY,
      rawRetentionDays: positiveInteger(input, "WEBFLIX_EVENTS_RETENTION_DAYS", 396, issues),
      aggregateRetentionDays: positiveInteger(
        input,
        "WEBFLIX_AGGREGATES_RETENTION_DAYS",
        1126,
        issues,
      ),
      deletionCoolingOffSec: positiveInteger(
        input,
        "WEBFLIX_DELETION_COOLING_OFF_SEC",
        14 * 24 * 3600,
        issues,
      ),
      exportLinkTtlSec: positiveInteger(
        input,
        "WEBFLIX_EXPORT_LINK_TTL_SEC",
        7 * 24 * 3600,
        issues,
      ),
      serverRelease: RELEASE.test(release) ? release : DEFAULT_SERVER_RELEASE,
      exportEvents,
      exportTypicalSec: positiveInteger(
        input,
        "WEBFLIX_EXPORT_TYPICAL_SEC",
        EXPORT_TYPICAL_SEC[exportEvents],
        issues,
      ),
    },
    issues,
  };
}
