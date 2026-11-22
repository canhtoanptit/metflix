/**
 * The events area in the Workers runtime (workerd): the lake writer over R2 against the
 * EventSink contract (gzip by CompressionStream, partition listing, private documents), the
 * whole collection path on D1 and R2 (ingest, the consumer, server events, an export and an
 * erasure), and the routes through the real Worker.
 */
import { applyD1Migrations, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createR2BlobStore } from "@webflix/adapters-cloudflare";
import { type ClientEventInput, LakeEvent } from "@webflix/contracts";
import { makeClientEventInput } from "@webflix/contracts/fixtures";
import {
  createBlobLakeEventSink,
  createSubjectKeys,
  createUuidV7Generator,
  DEV_ONLY_PSEUDONYM_KEY,
  decodeLakeObject,
  scopeBlobStore,
} from "@webflix/core";
import {
  createTestServices,
  describeEventSinkContract,
  makeAccountRecord,
  makeProfileRow,
  makeSessionRecord,
  makeSubscriptionRecord,
  readAll,
  TEST_NOW,
} from "@webflix/core/testing";
import { createRepositories } from "@webflix/db";
import { createD1Database } from "@webflix/db/d1";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describeEventSinkContract("lake writer over R2 (workerd)", async () => {
  const blobs = scopeBlobStore(createR2BlobStore(env.MEDIA), `test-${crypto.randomUUID()}`);
  const sink = createBlobLakeEventSink({ blobs, ids: createUuidV7Generator() });
  return {
    sink,
    async readBack() {
      const { items } = await blobs.list({ prefix: "events/" });
      return Promise.all(
        items.map(async (item) => {
          const object = await blobs.get(item.key);
          if (!object) throw new Error(`${item.key} vanished`);
          return { key: item.key, events: await decodeLakeObject(await readAll(object.body)) };
        }),
      );
    },
  };
});

let sequence = 0;
function clientEvent(type: "impression" | "title.open"): ClientEventInput {
  sequence += 1;
  return makeClientEventInput(type, {
    eventId: `0193a1d2-7c4e-7a10-8f00-${sequence.toString(16).padStart(12, "0")}`,
    deviceId: "dev-workerd",
    sessionSeq: sequence,
  });
}

describe("collection on D1 and R2 in workerd", () => {
  it("ingests, writes gzip NDJSON to R2 by receipt hour, exports and erases", async () => {
    const database = createD1Database(env.DB);
    const repos = createRepositories(database);
    const blobs = scopeBlobStore(createR2BlobStore(env.MEDIA), `flow-${crypto.randomUUID()}`);
    const t = await createTestServices({
      repos,
      seed: false,
      config: { WEBFLIX_CONSENT_MODE: "opt-out", WEBFLIX_EVENT_SINK: "lake" },
    });
    const ids = createUuidV7Generator();
    const { createServices } = await import("@webflix/core");
    const services = createServices({
      ...t.deps,
      eventSink: createBlobLakeEventSink({ blobs, ids }),
    });
    t.queue.setProcessor(services.processor);

    const accountId = `acc-${crypto.randomUUID().slice(0, 8)}`;
    const session = makeSessionRecord({
      id: `ses-${accountId}`,
      tokenHash: `hash-${accountId}`,
      accountId,
      createdAt: TEST_NOW,
      lastSeenAt: TEST_NOW,
      expiresAt: TEST_NOW + 30 * 86_400_000,
    });
    await repos.accounts.createWithSession({
      account: makeAccountRecord({ id: accountId, email: `${accountId}@example.com` }),
      subscription: makeSubscriptionRecord({ accountId, planId: "basic" }),
      session,
    });
    const profile = makeProfileRow({ id: `${accountId}-p`, accountId });
    const kids = makeProfileRow({
      id: `${accountId}-k`,
      accountId,
      isKids: true,
      maturityCeiling: "7+",
    });
    await repos.profiles.createWithinLimit(profile, 5);
    await repos.profiles.createWithinLimit(kids, 5);
    const auth = {
      session: { ...session, activeProfileId: profile.id },
      profile: { ...profile, avatar: null },
    };

    const ack = await services.events.ingest({
      auth,
      events: [clientEvent("impression"), clientEvent("title.open")],
      gpc: false,
      country: "DE",
    });
    expect(ack).toEqual({ accepted: 2, dropped: 0 });
    const kidsAck = await services.events.ingest({
      auth: { session: auth.session, profile: { ...kids, avatar: null } },
      events: [clientEvent("impression")],
      gpc: false,
      country: null,
    });
    expect(kidsAck).toEqual({ accepted: 0, dropped: 1 });
    await services.events.emitServerEvent({
      type: "billing.transition",
      payload: { from: "trialing", to: "active", planId: "basic" },
      accountId,
      profileId: null,
    });
    await t.queue.drain();

    const { items } = await blobs.list({ prefix: "events/" });
    expect(items.length).toBe(2); // one object per append, both in the 12:00 hour
    expect(items.every((item) => item.key.startsWith("events/dt=2026-06-15/hh=12/"))).toBe(true);
    const stored: LakeEvent[] = [];
    for (const item of items) {
      const object = await blobs.get(item.key);
      const bytes = await readAll(object?.body ?? new ReadableStream());
      expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]); // gzip
      for (const event of await decodeLakeObject(bytes)) stored.push(LakeEvent.parse(event));
    }
    const keys = createSubjectKeys(DEV_ONLY_PSEUDONYM_KEY);
    expect(stored.map((event) => event.type).sort()).toEqual(
      ["billing.transition", "impression", "title.open"].sort(),
    );
    expect(stored.every((event) => event.subject.account === stored[0]?.subject.account)).toBe(
      true,
    );
    expect(stored[0]?.subject.account).toBe(await keys.account(accountId));
    expect(stored.find((event) => event.type === "impression")?.subject).toMatchObject({
      plan: "basic",
      country: "DE",
    });

    // Export: the document lands in R2 under privacy/, the download serves it.
    await t.deps.repos.identity.elevateSession(session.id, accountId, TEST_NOW + 300_000, TEST_NOW);
    await services.events.requestExport(auth);
    await t.queue.drain();
    const [request] = (await services.events.listPrivacyRequests(auth)).items;
    const token = new URL(`http://x${request?.downloadUrl}`).searchParams.get("token") ?? "";
    const document = await services.events.downloadExport(auth, request?.id ?? "", token);
    expect(document.events.map((event) => event.eventId).sort()).toEqual(
      stored.map((event) => event.eventId).sort(),
    );
    expect((await blobs.list({ prefix: "privacy/" })).items).toHaveLength(1);

    // Erasure: the account goes (D1 cascades), the document goes, the subject is listed.
    await services.events.requestDeletion(auth);
    t.clock.advance(15 * 86_400_000);
    await services.scheduler.tick();
    await t.queue.drain();
    expect(await repos.accounts.get(accountId)).toBeNull();
    expect(await repos.profiles.list(accountId)).toEqual([]);
    expect((await blobs.list({ prefix: "privacy/" })).items).toEqual([]);
    expect(await services.events.staff.pendingErasures(10)).toContain(
      await keys.account(accountId),
    );
  });
});

describe("the routes through the Worker", () => {
  it("answers POST /events and the consent state (no 501)", async () => {
    const ingest = await SELF.fetch("http://localhost:8787/api/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webflix-Client": "web",
        "CF-Connecting-IP": "198.51.100.77",
      },
      body: JSON.stringify({ events: [clientEvent("impression")] }),
    });
    expect(ingest.status).toBe(202);
    // The local Worker runs opt-in: a signed-out device that has not answered is dropped.
    expect(await ingest.json()).toEqual({ accepted: 0, dropped: 1 });
    const consent = await SELF.fetch("http://localhost:8787/api/v1/privacy/consent", {
      headers: { "Sec-GPC": "1" },
    });
    expect(consent.status).toBe(200);
    expect(await consent.json()).toMatchObject({ mode: "opt-in", gpc: true, promptRequired: true });
  });
});
