/**
 * The JSON Schema export of `LakeEvent` (src/events.ts) for the recommendation pipeline.
 *
 * Laid out the way services/recs consumed its provisional schema: one closed envelope, the
 * payload schemas under `$defs.payloads`, and one `if type == X then ...` rule per type under
 * `$defs.dispatch`. Dispatch by `if/then` is cheap for a validator (a constant check per rule),
 * unlike `oneOf`, which must try every branch; the pipeline validates tens of millions of
 * events. `services/recs/src/webflix_recs/schemas.py` reads the vocabulary (`$defs.eventType`,
 * the source of each type, the row kinds) from this document, so the schema stays the single
 * source on that side too.
 *
 * `pnpm --filter @webflix/contracts generate` writes it to services/recs/schemas/event.schema.json.
 */
import * as z from "zod";
import { CLIENT_PLATFORMS, EVENT_TYPES, EVENT_VERSION, type EventType } from "./constants.ts";
import {
  EVENT_PAYLOADS,
  eventSchemaParts,
  eventSource,
  PROFILELESS_EVENT_TYPES,
} from "./events.ts";

export type JsonSchemaDocument = { [key: string]: unknown };

/** Where the generated file lives, relative to the repository root. */
export const EVENT_SCHEMA_PATH = "services/recs/schemas/event.schema.json";

function toJson(schema: z.ZodType): JsonSchemaDocument {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "throw",
    reused: "inline",
  }) as JsonSchemaDocument;
  if ("$defs" in rest) throw new Error("event schema parts must not carry ids ($defs)");
  return rest;
}

const ref = (path: string) => ({ $ref: `#/$defs/${path}` });

function dispatchRule(type: EventType): JsonSchemaDocument {
  const client = eventSource(type) === "client";
  const properties: JsonSchemaDocument = {
    source: { const: client ? "client" : "server" },
    payload: ref(`payloads/${type}`),
  };
  if (client) {
    properties.deviceId = ref("opaqueId");
    properties.sessionSeq = { type: "integer", minimum: 0 };
    properties.app = { properties: { platform: { enum: [...CLIENT_PLATFORMS] } } };
  } else {
    properties.sessionSeq = { type: "null" };
    properties.app = { properties: { platform: { const: "server" } } };
  }
  if ((PROFILELESS_EVENT_TYPES as readonly string[]).includes(type)) {
    properties.subject = { properties: { profile: { type: "null" } } };
  }
  return {
    if: { properties: { type: { const: type } } },
    // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then keyword; never awaited.
    then: { properties },
  };
}

/** The pipeline's event schema, generated from the contract. Deterministic. */
export function buildEventJsonSchema(): JsonSchemaDocument {
  const parts = eventSchemaParts;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://webflix.dev/schemas/event/${EVENT_VERSION}`,
    title: `Webflix behaviour event (envelope version ${EVENT_VERSION})`,
    description:
      "One event as stored in the event lake (docs/BLUEPRINT-M2.md §6.1). GENERATED from packages/contracts/src/events.ts by `pnpm --filter @webflix/contracts generate`; do not edit. Closed at every level: a new optional field is a new `version` of its type.",
    type: "object",
    additionalProperties: false,
    required: [
      "eventId",
      "type",
      "version",
      "source",
      "occurredAt",
      "receivedAt",
      "deviceId",
      "sessionSeq",
      "app",
      "context",
      "subject",
      "payload",
    ],
    properties: {
      eventId: {
        description: "UUIDv7, generated where the event is created. The lake's deduplication key.",
        ...ref("uuidv7"),
      },
      type: ref("eventType"),
      version: {
        description:
          "Version of this type's payload schema. Readers accept the versions they know and count the rest.",
        type: "integer",
        const: EVENT_VERSION,
      },
      source: {
        description:
          "`client` events come from the telemetry SDK (untrusted clock and ids); `server` events from Webflix services.",
        enum: ["client", "server"],
      },
      occurredAt: {
        description: "When it happened, by the producer's clock.",
        ...ref("timestamp"),
      },
      receivedAt: {
        description:
          "When ingestion accepted it (server clock). The lake partition comes from this.",
        ...ref("timestamp"),
      },
      deviceId: {
        description: "Anonymous device id; null on server events not tied to a device.",
        anyOf: [ref("opaqueId"), { type: "null" }],
      },
      sessionSeq: {
        description: "Per-device counter within the app session; null on server events.",
        anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
      },
      app: toJson(parts.EventApp),
      context: ref("context"),
      subject: ref("subject"),
      payload: { type: "object" },
    },
    allOf: EVENT_TYPES.map((type) => ref(`dispatch/${type}`)),
    $defs: {
      eventType: { enum: [...EVENT_TYPES] },
      uuidv7: toJson(parts.EventId),
      timestamp: toJson(parts.EventTimestamp),
      opaqueId: toJson(parts.EventOpaqueId),
      titleId: toJson(parts.EventTitleId),
      pseudonym: toJson(parts.SubjectKey),
      context: toJson(parts.EventContext),
      subject: toJson(parts.EventSubject),
      payloads: Object.fromEntries(EVENT_TYPES.map((type) => [type, toJson(EVENT_PAYLOADS[type])])),
      dispatch: Object.fromEntries(EVENT_TYPES.map((type) => [type, dispatchRule(type)])),
    },
  };
}

/**
 * The generated file's content before formatting (the generator then runs Biome over it, which
 * the root lint checks; the staleness test compares parsed documents, not text).
 */
export function eventJsonSchemaFile(): string {
  return `${JSON.stringify(buildEventJsonSchema(), null, 2)}\n`;
}
