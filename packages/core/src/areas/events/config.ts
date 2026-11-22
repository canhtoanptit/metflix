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
}

/**
 * Variables: WEBFLIX_EVENT_SINK (default memory), WEBFLIX_CONSENT_MODE (default opt-in),
 * WEBFLIX_PSEUDONYM_KEY (32+ characters), WEBFLIX_EVENTS_RETENTION_DAYS (default 396, 13
 * months), WEBFLIX_AGGREGATES_RETENTION_DAYS (default 1126, 37 months),
 * WEBFLIX_DELETION_COOLING_OFF_SEC (default 1209600, 14 days), WEBFLIX_EXPORT_LINK_TTL_SEC
 * (default 604800, 7 days), WEBFLIX_RELEASE (default `dev`).
 */
export function loadEventsConfig(input: AreaConfigInput): AreaConfigResult<EventsAreaConfig> {
  const issues: string[] = [];
  const eventSink = choice(input, "WEBFLIX_EVENT_SINK", EVENT_SINK_ADAPTERS, "memory", issues);
  const key = secret(input, "WEBFLIX_PSEUDONYM_KEY", 32, issues);
  if (!key && input.environment === "production" && eventSink !== "memory") {
    issues.push("WEBFLIX_PSEUDONYM_KEY: required in production once events are stored");
  }
  const release = input.vars.WEBFLIX_RELEASE ?? DEFAULT_SERVER_RELEASE;
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
    },
    issues,
  };
}
