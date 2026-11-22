import { beforeEach, describe, expect, it } from "vitest";
import { buildEventJsonSchema, EVENT_SCHEMA_PATH } from "../src/event-schema.ts";
import {
  makeClientEventInput,
  makeLakeEvent,
  resetFixtures,
  SAMPLE_EVENT_PAYLOADS,
} from "../src/fixtures/index.ts";
import {
  CLIENT_EVENT_TYPES,
  ClientEventInput,
  EVENT_BATCH_MAX_EVENTS,
  EVENT_ROW_KINDS,
  EVENT_TYPES,
  EventBatch,
  eventSource,
  LakeEvent,
  SERVER_EVENT_TYPES,
} from "../src/index.ts";

const files = import.meta.glob<string>("../../../services/recs/schemas/event.schema.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

type Json = { [key: string]: unknown };

describe("event schema export (services/recs reads it)", () => {
  const exported = buildEventJsonSchema();
  const defs = exported.$defs as Json;

  it(`${EVENT_SCHEMA_PATH} is generated from the contract (run \`pnpm --filter @webflix/contracts generate\`)`, () => {
    const onDisk = Object.values(files)[0];
    expect(onDisk, `${EVENT_SCHEMA_PATH} is missing`).toBeDefined();
    expect(JSON.parse(onDisk ?? "{}")).toEqual(exported);
  });

  it("keeps the vocabulary the pipeline reads where it reads it", () => {
    expect((defs.eventType as Json).enum).toEqual([...EVENT_TYPES]);
    expect((exported.properties as Json).version).toMatchObject({ const: 1 });
    const dispatch = defs.dispatch as Record<string, { then: { properties: Json } }>;
    for (const type of EVENT_TYPES) {
      expect(dispatch[type]?.then.properties.source).toEqual({ const: eventSource(type) });
    }
    const rowView = (defs.payloads as Record<string, Json>)["row.view"] as {
      properties: { rowKind: { enum: string[] } };
    };
    expect(rowView.properties.rowKind.enum).toEqual([...EVENT_ROW_KINDS]);
  });

  it("is closed and self-contained", () => {
    expect(exported.additionalProperties).toBe(false);
    const text = JSON.stringify(exported);
    const refs = [...text.matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)].map((match) => match[1]);
    for (const ref of refs) {
      const target = (ref ?? "")
        .split("/")
        .reduce<unknown>((node, key) => (node as Json)?.[key], defs);
      expect(target, ref).toBeDefined();
    }
  });
});

describe("LakeEvent and ClientEventInput", () => {
  beforeEach(() => resetFixtures());

  it("accept a sample of every type", () => {
    for (const type of EVENT_TYPES) expect(makeLakeEvent(type).type).toBe(type);
    for (const type of CLIENT_EVENT_TYPES) expect(makeClientEventInput(type).type).toBe(type);
    expect(Object.keys(SAMPLE_EVENT_PAYLOADS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("refuse unknown fields at every level (a new field is a new version)", () => {
    const event = makeLakeEvent("impression");
    expect(LakeEvent.safeParse({ ...event, extra: 1 }).success).toBe(false);
    expect(LakeEvent.safeParse({ ...event, payload: { ...event.payload, extra: 1 } }).success).toBe(
      false,
    );
    expect(
      LakeEvent.safeParse({ ...event, subject: { ...event.subject, email: "x@y.z" } }).success,
    ).toBe(false);
  });

  it("refuse a client-supplied identity and a server-only type from the SDK", () => {
    const input = makeClientEventInput("title.open");
    const stamped = makeLakeEvent("title.open");
    expect(ClientEventInput.safeParse({ ...input, subject: stamped.subject }).success).toBe(false);
    expect(ClientEventInput.safeParse({ ...input, type: "playback.start" }).success).toBe(false);
    for (const type of SERVER_EVENT_TYPES) {
      expect(ClientEventInput.safeParse({ ...input, type }).success).toBe(false);
    }
  });

  it("enforce the envelope per source (corrections to the provisional schema)", () => {
    const client = makeLakeEvent("impression");
    expect(LakeEvent.safeParse({ ...client, deviceId: null }).success).toBe(false);
    expect(LakeEvent.safeParse({ ...client, sessionSeq: null }).success).toBe(false);
    expect(
      LakeEvent.safeParse({ ...client, app: { ...client.app, platform: "server" } }).success,
    ).toBe(false);
    const server = makeLakeEvent("playback.start");
    expect(
      LakeEvent.safeParse({ ...server, app: { ...server.app, platform: "web" } }).success,
    ).toBe(false);
    expect(LakeEvent.safeParse({ ...server, sessionSeq: 3 }).success).toBe(false);
    const signin = makeLakeEvent("auth.signin");
    expect(
      LakeEvent.safeParse({
        ...signin,
        subject: { ...signin.subject, profile: "pL4sD8fG2hJ6kZ1xC5vB9n" },
      }).success,
    ).toBe(false);
    // Title ids follow the contract's Id pattern.
    expect(
      LakeEvent.safeParse({ ...client, payload: { ...client.payload, titleId: "has space" } })
        .success,
    ).toBe(false);
  });

  it("limit a batch to EVENT_BATCH_MAX_EVENTS", () => {
    const events = Array.from({ length: EVENT_BATCH_MAX_EVENTS + 1 }, () =>
      makeClientEventInput("impression"),
    );
    expect(EventBatch.safeParse({ events: events.slice(1) }).success).toBe(true);
    expect(EventBatch.safeParse({ events }).success).toBe(false);
    expect(EventBatch.safeParse({ events: [] }).success).toBe(false);
  });
});
