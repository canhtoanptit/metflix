/**
 * Event fixtures: one valid payload per type, and lake and client events around them. Every
 * factory parses its output, so a fixture cannot drift from the schema.
 */
import { type ClientEventType, EVENT_VERSION, type EventType } from "../constants.ts";
import {
  ClientEventInput,
  type EventPayload,
  eventSource,
  LakeEvent,
  PROFILELESS_EVENT_TYPES,
} from "../events.ts";

const playback = {
  playbackSessionId: "ps-0001",
  titleId: "t-sintel",
  episodeId: null,
  positionSec: 312.5,
  durationSec: 888,
  watchedSec: 300,
};

/** A representative valid payload for every event type. */
export const SAMPLE_EVENT_PAYLOADS: { [T in EventType]: EventPayload<T> } = {
  impression: { titleId: "t-sintel", sampleRate: 0.25 },
  "row.view": { rowKind: "trending", itemCount: 20, sampleRate: 0.25 },
  "title.open": { titleId: "t-sintel" },
  "preview.start": { titleId: "t-sintel" },
  "preview.complete": { titleId: "t-sintel", watchedSec: 28.4 },
  "search.query": { queryLength: 6, resultCount: 14 },
  "search.click": { titleId: "t-sintel", resultRank: 2, queryLength: 6 },
  "list.add": { titleId: "t-sintel" },
  "list.remove": { titleId: "t-sintel" },
  "rating.set": { titleId: "t-sintel", value: "love" },
  "rating.clear": { titleId: "t-sintel" },
  "signup.step": { step: "plan", outcome: "completed" },
  "client.error": { code: "player.decode", fatal: false },
  "playback.start": playback,
  "playback.progress": playback,
  "playback.complete": { ...playback, positionSec: 870, watchedSec: 850 },
  "playback.abandon": { ...playback, reason: "closed" },
  "billing.transition": { from: "trialing", to: "active", planId: "standard" },
  "auth.signin": { method: "oidc", outcome: "success" },
  "auth.signup": { method: "password", outcome: "success" },
  "experiment.exposure": {
    experimentKey: "recs.learned-vs-rules",
    variant: "treatment",
    unitType: "profile",
  },
  "consent.change": { purpose: "personalisation", granted: false, source: "settings" },
};

const OCCURRED = "2026-11-22T10:15:30.120Z";
const RECEIVED = "2026-11-22T10:15:30.845Z";
const context = {
  surface: "home" as const,
  rowId: "home:trending",
  rowRank: 3,
  rank: 2,
  experiments: { "recs.learned-vs-rules": "treatment" },
  policy: { id: "rules-v1", explore: false },
};
const subject = {
  account: "aK3vB8nQ2wE5rT7yU9iO1p",
  profile: "pL4sD8fG2hJ6kZ1xC5vB9n",
  plan: "standard" as const,
  country: "US",
  restricted: false,
  consent: { analytics: true, personalisation: true },
};

let eventSequence = 0;

/** Called by `resetFixtures`. */
export function resetEventFixtures(): void {
  eventSequence = 0;
}

/** A UUIDv7-shaped id, deterministic per call order. */
function eventId(): string {
  eventSequence += 1;
  return `0193a1d2-7c4e-7a10-8f00-${eventSequence.toString(16).padStart(12, "0")}`;
}

/** A valid lake event of `type` (client or server envelope as the type requires). */
export function makeLakeEvent<T extends EventType>(
  type: T,
  overrides: Partial<Record<string, unknown>> = {},
): Extract<LakeEvent, { type: T }> {
  const client = eventSource(type) === "client";
  const profileless = (PROFILELESS_EVENT_TYPES as readonly string[]).includes(type);
  return LakeEvent.parse({
    eventId: eventId(),
    type,
    version: EVENT_VERSION,
    source: client ? "client" : "server",
    occurredAt: OCCURRED,
    receivedAt: RECEIVED,
    deviceId: client ? "d7f3a91c2b6e4d08" : null,
    sessionSeq: client ? 17 : null,
    app: { platform: client ? "web" : "server", version: "2026.11.22" },
    context: client ? context : { ...context, rowId: null, rowRank: null, rank: null },
    subject: profileless ? { ...subject, profile: null } : subject,
    payload: SAMPLE_EVENT_PAYLOADS[type],
    ...overrides,
  }) as Extract<LakeEvent, { type: T }>;
}

/** A valid `POST /events` item of a client type. */
export function makeClientEventInput<T extends ClientEventType>(
  type: T,
  overrides: Partial<Record<string, unknown>> = {},
): Extract<ClientEventInput, { type: T }> {
  return ClientEventInput.parse({
    eventId: eventId(),
    type,
    version: EVENT_VERSION,
    occurredAt: OCCURRED,
    deviceId: "d7f3a91c2b6e4d08",
    sessionSeq: 17,
    app: { platform: "web", version: "2026.11.22" },
    context,
    payload: SAMPLE_EVENT_PAYLOADS[type],
    ...overrides,
  }) as Extract<ClientEventInput, { type: T }>;
}
