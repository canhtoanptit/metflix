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

/** Portable behaviour-collection and privacy settings (milestone 2 §6). Owned by the events area. */
export interface EventsAreaConfig {
  eventSink: (typeof EVENT_SINK_ADAPTERS)[number];
  consentMode: (typeof CONSENT_MODES)[number];
  /** HMAC key of the pseudonymous account and profile keys (services/recs README decision 3). */
  pseudonymKey: string;
  rawRetentionDays: number;
  aggregateRetentionDays: number;
}

/**
 * Variables: WEBFLIX_EVENT_SINK (default memory), WEBFLIX_CONSENT_MODE (default opt-in),
 * WEBFLIX_PSEUDONYM_KEY (32+ characters), WEBFLIX_EVENTS_RETENTION_DAYS (default 396, 13
 * months), WEBFLIX_AGGREGATES_RETENTION_DAYS (default 1126, 37 months).
 */
export function loadEventsConfig(input: AreaConfigInput): AreaConfigResult<EventsAreaConfig> {
  const issues: string[] = [];
  const eventSink = choice(input, "WEBFLIX_EVENT_SINK", EVENT_SINK_ADAPTERS, "memory", issues);
  const key = secret(input, "WEBFLIX_PSEUDONYM_KEY", 32, issues);
  if (!key && input.environment === "production" && eventSink !== "memory") {
    issues.push("WEBFLIX_PSEUDONYM_KEY: required in production once events are stored");
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
    },
    issues,
  };
}
