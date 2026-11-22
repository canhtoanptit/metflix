/**
 * Behaviour events (docs/BLUEPRINT-M2.md §6.1): the single source of the event schema.
 *
 * Adopted from the recommendation pipeline's provisional schema and its fifteen decisions
 * (services/recs/README.md, "Event schema"), with three corrections recorded in
 * docs/CONTRACT_CHANGES.md: title and episode ids use the contract's `Id` pattern; client events
 * always carry a device, a session sequence and a client platform while server events carry the
 * `server` platform and no sequence; sign-in and sign-up events carry no profile.
 *
 * - `ClientEventInput`: one event as the telemetry SDK sends it in `POST /events` (no `source`,
 *   `receivedAt` or `subject`: the server adds them; a client-supplied identity is refused).
 * - `LakeEvent`: one event as stored in the event lake, client or server.
 * - `buildEventJsonSchema()` (`@webflix/contracts/event-schema`) exports `LakeEvent` as JSON
 *   Schema 2020-12 for the pipeline: services/recs/schemas/event.schema.json is generated from
 *   it (`pnpm --filter @webflix/contracts generate`; a test fails while it is stale).
 *
 * Schemas are closed at every level: a new optional field is a new `version` of its type.
 * No schema here carries a `.meta({ id })`, so the JSON export is self-contained.
 */
import * as z from "zod";
import { ID_PATTERN } from "./common.ts";
import {
  AUTH_EVENT_METHODS,
  AUTH_EVENT_OUTCOMES,
  CLIENT_EVENT_TYPES,
  CLIENT_PLATFORMS,
  type ClientEventType,
  CONSENT_PURPOSES,
  CONSENT_SOURCES,
  EVENT_BATCH_MAX_EVENTS,
  EVENT_PLATFORMS,
  EVENT_ROW_KINDS,
  EVENT_SURFACES,
  EVENT_TYPES,
  EVENT_VERSION,
  type EventType,
  EXPERIMENT_UNIT_TYPES,
  MEMBERSHIP_STATUSES,
  PLAN_IDS,
  PLAYBACK_ABANDON_REASONS,
  RATING_VALUES,
  SEARCH_QUERY_MAX_LENGTH,
  SERVER_EVENT_TYPES,
  type ServerEventType,
  SIGNUP_STEP_OUTCOMES,
  SIGNUP_STEPS,
} from "./constants.ts";

// --- Scalars ----------------------------------------------------------------------------------

/** UUIDv7, lowercase, generated where the event is created: the lake's deduplication key. */
export const EventId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
/** RFC 3339 UTC with milliseconds, exactly `Date.prototype.toISOString()`. */
export const EventTimestamp = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/);
/** Anonymous, client-generated device id (also a playback session id's shape). */
export const EventOpaqueId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
/** A title or episode id (the contract's `Id` pattern). */
export const EventTitleId = z.string().regex(ID_PATTERN);
/**
 * Pseudonymous key: base64url(HMAC-SHA256(key, "account:" + id | "profile:" + id)), first 22
 * characters (128 bits). Recommendation artefacts are keyed by the profile's.
 */
export const SubjectKey = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const EventExperimentKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const EventVariant = z.string().min(1).max(64);
const SampleRate = z.number().gt(0).max(1);
const QueryLength = z.number().int().min(0).max(SEARCH_QUERY_MAX_LENGTH);
const AppVersion = z.string().min(1).max(40);

// --- Envelope parts ---------------------------------------------------------------------------

export const EventApp = z.strictObject({ platform: z.enum(EVENT_PLATFORMS), version: AppVersion });
const ClientApp = z.strictObject({ platform: z.enum(CLIENT_PLATFORMS), version: AppVersion });
const ServerApp = z.strictObject({ platform: z.literal("server"), version: AppVersion });

export const EventPolicy = z.strictObject({ id: z.string().min(1).max(64), explore: z.boolean() });

/**
 * Where it happened. `rowRank` (module position on the page, billboard = 1) and `rank` (card
 * position in the row) are 1-based and are sent on impressions and on the title-open that
 * follows: position-bias correction credits an impression only when that exact card opened.
 */
export const EventContext = z.strictObject({
  surface: z.enum(EVENT_SURFACES).nullable(),
  /** The engine's row id (`home:genre:thriller`); `{view}:billboard` for the billboard. */
  rowId: z.string().min(1).max(128).nullable(),
  rowRank: z.number().int().min(1).nullable(),
  rank: z.number().int().min(1).nullable(),
  /** Assignments in force for the unit: experiment key → variant. */
  experiments: z.record(EventExperimentKey, EventVariant),
  /** The ranking policy that built the page and whether it was an exploration page. */
  policy: EventPolicy.nullable(),
});
export type EventContext = z.output<typeof EventContext>;

/**
 * Stamped by the server from the session at receipt; never taken from the client. `restricted`:
 * a kids profile or a lowered maturity ceiling (`standingOf`): excluded from training,
 * analytics and experiments. `consent`: the account's consent in force at receipt.
 */
export const EventSubject = z.strictObject({
  account: SubjectKey.nullable(),
  profile: SubjectKey.nullable(),
  plan: z.enum(PLAN_IDS).nullable(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  restricted: z.boolean(),
  consent: z.strictObject({ analytics: z.boolean(), personalisation: z.boolean() }),
});
export type EventSubject = z.output<typeof EventSubject>;
/** Sign-ins and sign-ups happen before a profile is chosen. */
const ProfilelessSubject = EventSubject.extend({ profile: z.null() });

// --- Payloads, one per type -------------------------------------------------------------------

const playbackItem = {
  playbackSessionId: EventOpaqueId,
  titleId: EventTitleId,
  episodeId: EventTitleId.nullable(),
  positionSec: z.number().min(0),
  durationSec: z.number().gt(0),
  /** Seconds credited to this playback session so far (the server's credit clock). */
  watchedSec: z.number().min(0),
};
const membershipState = z.enum(MEMBERSHIP_STATUSES);
const titleOnly = () => z.strictObject({ titleId: EventTitleId });

export const EVENT_PAYLOADS = {
  /** A card visible for at least 1 s; sampled per app session (a sampled session logs all). */
  impression: z.strictObject({ titleId: EventTitleId, sampleRate: SampleRate }),
  "row.view": z.strictObject({
    rowKind: z.enum(EVENT_ROW_KINDS),
    itemCount: z.number().int().min(0),
    sampleRate: SampleRate,
  }),
  "title.open": titleOnly(),
  "preview.start": titleOnly(),
  "preview.complete": z.strictObject({ titleId: EventTitleId, watchedSec: z.number().min(0) }),
  /** No query text: its length and the result count only. */
  "search.query": z.strictObject({
    queryLength: QueryLength,
    resultCount: z.number().int().min(0),
  }),
  "search.click": z.strictObject({
    titleId: EventTitleId,
    resultRank: z.number().int().min(1),
    queryLength: QueryLength,
  }),
  "list.add": titleOnly(),
  "list.remove": titleOnly(),
  "rating.set": z.strictObject({ titleId: EventTitleId, value: z.enum(RATING_VALUES) }),
  "rating.clear": titleOnly(),
  "signup.step": z.strictObject({
    step: z.enum(SIGNUP_STEPS),
    outcome: z.enum(SIGNUP_STEP_OUTCOMES),
  }),
  "client.error": z.strictObject({ code: z.string().min(1).max(64), fatal: z.boolean() }),
  "playback.start": z.strictObject(playbackItem),
  /** Emitted as credited watching crosses each quarter of the item's duration. */
  "playback.progress": z.strictObject(playbackItem),
  /** The item reached the completion ratio (95%) or ended. */
  "playback.complete": z.strictObject(playbackItem),
  "playback.abandon": z.strictObject({
    ...playbackItem,
    reason: z.enum(PLAYBACK_ABANDON_REASONS),
  }),
  /** A membership state change (§5.2). */
  "billing.transition": z.strictObject({
    from: membershipState,
    to: membershipState,
    planId: z.enum(PLAN_IDS).nullable(),
  }),
  "auth.signin": z.strictObject({
    method: z.enum(AUTH_EVENT_METHODS),
    outcome: z.enum(AUTH_EVENT_OUTCOMES),
  }),
  "auth.signup": z.strictObject({
    method: z.enum(AUTH_EVENT_METHODS),
    outcome: z.enum(AUTH_EVENT_OUTCOMES),
  }),
  /** Logged when the treatment is experienced, not when assigned (§8.1). */
  "experiment.exposure": z.strictObject({
    experimentKey: EventExperimentKey,
    variant: EventVariant,
    unitType: z.enum(EXPERIMENT_UNIT_TYPES),
  }),
  /**
   * The account's consent for one purpose changed (§6.3). The subject stamp carries the new
   * state, so a withdrawal is honoured even if the member never returns.
   */
  "consent.change": z.strictObject({
    purpose: z.enum(CONSENT_PURPOSES),
    granted: z.boolean(),
    source: z.enum(CONSENT_SOURCES),
  }),
} as const satisfies Record<EventType, z.ZodObject>;

export type EventPayload<T extends EventType> = z.output<(typeof EVENT_PAYLOADS)[T]>;

/** Server events that happen before a profile is chosen (their subject has no profile). */
export const PROFILELESS_EVENT_TYPES = [
  "auth.signin",
  "auth.signup",
] as const satisfies readonly ServerEventType[];

export function eventSource(type: EventType): "client" | "server" {
  return (SERVER_EVENT_TYPES as readonly string[]).includes(type) ? "server" : "client";
}

// --- Envelopes --------------------------------------------------------------------------------

const common = {
  eventId: EventId,
  version: z.literal(EVENT_VERSION),
  occurredAt: EventTimestamp,
  context: EventContext,
};
const clientEnvelope = {
  ...common,
  source: z.literal("client"),
  receivedAt: EventTimestamp,
  deviceId: EventOpaqueId,
  /** Per-device counter within the app session (reset at app start): order and loss. */
  sessionSeq: z.number().int().min(0),
  app: ClientApp,
  subject: EventSubject,
};
const serverEnvelope = {
  ...common,
  source: z.literal("server"),
  receivedAt: EventTimestamp,
  deviceId: EventOpaqueId.nullable(),
  sessionSeq: z.null(),
  app: ServerApp,
  subject: EventSubject,
};
const ClientEnvelope = z.strictObject(clientEnvelope);
const ServerEnvelope = z.strictObject(serverEnvelope);

type Envelope<T extends EventType> = T extends ClientEventType
  ? z.output<typeof ClientEnvelope>
  : T extends (typeof PROFILELESS_EVENT_TYPES)[number]
    ? Omit<z.output<typeof ServerEnvelope>, "subject"> & {
        subject: z.output<typeof ProfilelessSubject>;
      }
    : z.output<typeof ServerEnvelope>;

/** One event as stored in the lake, discriminated by `type`. */
export type LakeEvent = {
  [T in EventType]: Envelope<T> & { type: T; payload: EventPayload<T> };
}[EventType];

function lakeVariant(type: EventType) {
  if (eventSource(type) === "client") {
    return z.strictObject({
      ...clientEnvelope,
      type: z.literal(type),
      payload: EVENT_PAYLOADS[type],
    });
  }
  const profileless = (PROFILELESS_EVENT_TYPES as readonly string[]).includes(type);
  return z.strictObject({
    ...serverEnvelope,
    ...(profileless ? { subject: ProfilelessSubject } : {}),
    type: z.literal(type),
    payload: EVENT_PAYLOADS[type],
  });
}

const lakeVariants = EVENT_TYPES.map(lakeVariant);

/** Runtime schema of a lake event (validated by the lake writer and by tests). */
export const LakeEvent = z
  .discriminatedUnion(
    "type",
    // The tuple type cannot come out of `map`; every element is a lake variant.
    lakeVariants as unknown as [(typeof lakeVariants)[number], ...(typeof lakeVariants)[number][]],
  )
  .meta({ id: "LakeEvent" }) as unknown as z.ZodType<LakeEvent>;

// --- What the SDK sends -----------------------------------------------------------------------

const clientInputEnvelope = {
  ...common,
  deviceId: EventOpaqueId,
  sessionSeq: z.number().int().min(0),
  app: ClientApp,
};
const ClientInputEnvelope = z.strictObject(clientInputEnvelope);

/** One client event as `POST /events` accepts it. */
export type ClientEventInput = {
  [T in ClientEventType]: z.output<typeof ClientInputEnvelope> & {
    type: T;
    payload: EventPayload<T>;
  };
}[ClientEventType];

const clientInputVariants = CLIENT_EVENT_TYPES.map((type) =>
  z.strictObject({ ...clientInputEnvelope, type: z.literal(type), payload: EVENT_PAYLOADS[type] }),
);

export const ClientEventInput = z
  .discriminatedUnion(
    "type",
    clientInputVariants as unknown as [
      (typeof clientInputVariants)[number],
      ...(typeof clientInputVariants)[number][],
    ],
  )
  .meta({ id: "ClientEventInput" }) as unknown as z.ZodType<ClientEventInput>;

/**
 * `POST /events`: at most `EVENT_BATCH_MAX_EVENTS` events and `EVENT_BATCH_MAX_BYTES`. `consent`
 * is a signed-out device's own answer (opt-in mode); for a signed-in session the account's
 * consent applies and this is ignored.
 */
export const EventBatch = z
  .object({
    events: z.array(ClientEventInput).min(1).max(EVENT_BATCH_MAX_EVENTS),
    consent: z.object({ analytics: z.boolean(), personalisation: z.boolean() }).optional(),
  })
  .meta({ id: "EventBatch" });
export type EventBatch = z.input<typeof EventBatch>;

/** Accepted for the lake (at least once: consumers deduplicate by `eventId`). */
export const EventBatchAck = z
  .object({
    accepted: z.number().int().nonnegative(),
    /** Dropped by consent or because the profile is restricted; never an error. */
    dropped: z.number().int().nonnegative(),
  })
  .meta({ id: "EventBatchAck" });
export type EventBatchAck = z.output<typeof EventBatchAck>;

// --- Diagnostics (non-production) -------------------------------------------------------------

export const RecentEventsQuery = z.object({
  /** One profile of the signed-in account (its pseudonym is derived server-side). */
  profileId: z.string().regex(ID_PATTERN).optional(),
  deviceId: EventOpaqueId.optional(),
  since: EventTimestamp.optional(),
  limit: z.coerce.number<number>().int().min(1).max(500).optional(),
});
export type RecentEventsQuery = z.input<typeof RecentEventsQuery>;

/** What ingestion accepted recently for the signed-in account (newest first). */
export const RecentEvents = z.object({ items: z.array(LakeEvent) }).meta({ id: "RecentEvents" });
export type RecentEvents = z.output<typeof RecentEvents>;

/** Re-exported for the JSON Schema export (`event-schema.ts`). */
export const eventSchemaParts = {
  EventId,
  EventTimestamp,
  EventOpaqueId,
  EventTitleId,
  SubjectKey,
  EventApp,
  EventContext,
  EventSubject,
} as const;
