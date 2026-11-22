/**
 * `POST /events` behind the route (milestone 2 §6.1, §6.2): what ingestion stamps, what it
 * drops, and that what the client sent about positions and policy reaches the lake untouched.
 */
import { EVENT_BATCH_MAX_EVENTS, EventSubject, LakeEvent } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { createSubjectKeys, DEV_ONLY_PSEUDONYM_KEY } from "../../src/index.ts";
import { clientEvent, createMember, eventServices, lakeEvents, settle } from "./helpers.ts";

describe("ingestion of client batches", () => {
  it("stamps receipt time, source and the server's subject, then writes them to the lake", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    const events = [clientEvent("impression"), clientEvent("title.open")];
    const ack = await t.services.events.ingest({
      auth: member.as("adult"),
      events,
      gpc: false,
      country: "GB",
    });
    expect(ack).toEqual({ accepted: 2, dropped: 0 });
    expect(lakeEvents(t.sink)).toEqual([]); // queued, not yet written
    await settle(t);
    const stored = lakeEvents(t.sink);
    expect(stored).toHaveLength(2);
    const keys = createSubjectKeys(DEV_ONLY_PSEUDONYM_KEY);
    for (const event of stored) {
      expect(LakeEvent.safeParse(event).success).toBe(true);
      expect(event.source).toBe("client");
      expect(event.receivedAt).toBe(new Date(t.clock.now()).toISOString());
      expect(event.subject).toEqual(
        EventSubject.parse({
          account: await keys.account(member.accountId),
          profile: await keys.profile(member.profiles.adult.id),
          plan: "premium",
          country: "GB",
          restricted: false,
          consent: { analytics: true, personalisation: true },
        }),
      );
    }
    expect(stored.map((event) => event.eventId)).toEqual(events.map((event) => event.eventId));
    // Partitioned by receipt hour.
    expect(t.sink.objects()[0]?.key).toMatch(
      /^events\/dt=2026-06-15\/hh=12\/[0-9a-f-]+\.ndjson\.gz$/,
    );
  });

  it("passes rowRank, rank and the ranking policy through untouched (impression and title-open)", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    const context = {
      surface: "home" as const,
      rowId: "home:genre:thriller",
      rowRank: 4,
      rank: 7,
      experiments: { "recs.learned-vs-rules": "treatment", "home.billboard": "b" },
      policy: { id: "learned-v3", explore: true },
    };
    const impression = clientEvent("impression", { context });
    const open = clientEvent("title.open", { context });
    await t.services.events.ingest({
      auth: member.as("adult"),
      events: [impression, open],
      gpc: false,
      country: null,
    });
    await settle(t);
    const stored = lakeEvents(t.sink);
    expect(stored.map((event) => event.context)).toEqual([context, context]);
    expect(stored.map((event) => event.payload)).toEqual([impression.payload, open.payload]);
  });

  it("accepts anonymous batches, stamped without identity", async () => {
    const t = await eventServices();
    const ack = await t.services.events.ingest({
      auth: null,
      events: [clientEvent("signup.step")],
      gpc: false,
      country: null,
    });
    expect(ack).toEqual({ accepted: 1, dropped: 0 });
    await settle(t);
    const [event] = lakeEvents(t.sink);
    expect(event?.subject).toEqual({
      account: null,
      profile: null,
      plan: null,
      country: null,
      restricted: false,
      consent: { analytics: true, personalisation: true },
    });
  });

  it("stamps a session at the profile gate with the account and no profile", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    await t.services.events.ingest({
      auth: member.as(null),
      events: [clientEvent("client.error")],
      gpc: false,
      country: null,
    });
    await settle(t);
    const [event] = lakeEvents(t.sink);
    expect(event?.subject.account).not.toBeNull();
    expect(event?.subject.profile).toBeNull();
  });

  it("refuses a batch that mixes devices", async () => {
    const t = await eventServices();
    await expect(
      t.services.events.ingest({
        auth: null,
        events: [
          clientEvent("impression"),
          clientEvent("impression", { deviceId: "other-device" }),
        ],
        gpc: false,
        country: null,
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("answers service_unavailable when the queue refuses, so the SDK keeps and retries the batch", async () => {
    const t = await eventServices();
    t.queue.publish = async () => {
      throw new Error("queue down");
    };
    await expect(
      t.services.events.ingest({
        auth: null,
        events: [clientEvent("impression")],
        gpc: false,
        country: null,
      }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    expect(t.logger.records.some((record) => record.msg === "events.enqueue_failed")).toBe(true);
  });

  it("queues a full batch of the largest events as one job within the queue's limit", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    const published: number[] = [];
    const publish = t.queue.publish.bind(t.queue);
    t.queue.publish = async (job, options) => {
      published.push(JSON.stringify(job).length);
      return publish(job, options);
    };
    const events = Array.from({ length: EVENT_BATCH_MAX_EVENTS }, () =>
      clientEvent("search.click", {
        context: {
          surface: "search",
          rowId: "x".repeat(128),
          rowRank: 1,
          rank: 1,
          experiments: Object.fromEntries(
            Array.from({ length: 8 }, (_, index) => [
              `exp-${index}-${"k".repeat(40)}`,
              "v".repeat(64),
            ]),
          ),
          policy: { id: "p".repeat(64), explore: false },
        },
      }),
    );
    // Over 64 KiB of input would be refused by the route; this batch is near that bound.
    expect(JSON.stringify({ events }).length).toBeGreaterThan(40_000);
    const ack = await t.services.events.ingest({
      auth: member.as("adult"),
      events,
      gpc: false,
      country: null,
    });
    expect(ack.accepted).toBe(EVENT_BATCH_MAX_EVENTS);
    expect(published.every((bytes) => bytes <= 128 * 1024)).toBe(true);
    await settle(t);
    expect(lakeEvents(t.sink)).toHaveLength(EVENT_BATCH_MAX_EVENTS);
  });

  it("does one consent read and one account read per batch, never per event", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    const store = (t.deps.repos as unknown as { store: { queries: number } }).store;
    const events = Array.from({ length: 50 }, () => clientEvent("impression"));
    const before = store.queries;
    await t.services.events.ingest({ auth: member.as("adult"), events, gpc: false, country: null });
    expect(store.queries - before).toBe(2);
  });
});
