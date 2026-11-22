/**
 * The events area over HTTP (milestone 2 §6): `POST /events`, consent, export, deletion and the
 * read-back, through the typed client and raw requests, on memory ports.
 */
import {
  API_BASE_PATH,
  type ClientEventInput,
  EVENT_BATCH_MAX_BYTES,
  EVENT_VERSION,
} from "@webflix/contracts";
import { makeClientEventInput } from "@webflix/contracts/fixtures";
import type { MemoryStore } from "@webflix/core/memory";
import { describe, expect, it } from "vitest";
import { createHandlers, pendingOperations } from "../src/index.ts";
import { createTestApp, DEMO, type Device, onboard, signIn, type TestApp } from "./support.ts";

const CLIENT = { "X-Webflix-Client": "web", "Content-Type": "application/json" };
let sequence = 0;

function event(overrides: Partial<Record<string, unknown>> = {}): ClientEventInput {
  sequence += 1;
  return makeClientEventInput("impression", {
    eventId: `0193a1d2-7c4e-7a10-8f00-${sequence.toString(16).padStart(12, "0")}`,
    deviceId: "dev-http-1",
    sessionSeq: sequence,
    ...overrides,
  });
}

async function demoOn(t: TestApp, profileId: string): Promise<Device> {
  return signIn(t, DEMO.email, DEMO.password, "Mozilla/5.0 Firefox/130.0", profileId);
}

/** Grant every live session of the device's account a fresh proof (identity's elevation). */
async function elevate(t: TestApp, device: Device): Promise<void> {
  const session = await device.api.getSession({ query: {} });
  if (!session.authenticated) throw new Error("not signed in");
  const store = (t.deps.repos as unknown as { store: MemoryStore }).store;
  const now = t.clock.now();
  for (const record of store.sessions.values()) {
    if (record.accountId === session.account.id) {
      await t.deps.repos.identity.elevateSession(record.id, record.accountId, now + 300_000, now);
    }
  }
}

describe("POST /events", () => {
  it("accepts a signed-in batch (202) and the read-back shows it once the consumer ran", async () => {
    const t = await createTestApp({ config: { WEBFLIX_CONSENT_MODE: "opt-out" } });
    const device = await demoOn(t, "pr-demo");
    const events = [event(), event({ type: "title.open", payload: { titleId: "t-orbit" } })];
    const response = await device.request(`${API_BASE_PATH}/events`, {
      method: "POST",
      headers: CLIENT,
      body: JSON.stringify({ events }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 2, dropped: 0 });
    await t.queue.drain();
    const back = await device.api.getRecentEvents({ query: { profileId: "pr-demo" } });
    expect(back.items.map((item) => item.eventId).sort()).toEqual(
      events.map((item) => item.eventId).sort(),
    );
    expect(back.items.every((item) => item.subject.profile !== null)).toBe(true);
  });

  it("drops a kids profile's batch: nothing to read back", async () => {
    const t = await createTestApp({ config: { WEBFLIX_CONSENT_MODE: "opt-out" } });
    const device = await demoOn(t, "pr-kids");
    const ack = await device.api.ingestEvents({ body: { events: [event(), event()] } });
    expect(ack).toEqual({ accepted: 0, dropped: 2 });
    await t.queue.drain();
    expect((await device.api.getRecentEvents({ query: { profileId: "pr-kids" } })).items).toEqual(
      [],
    );
    // The account's own sign-in (identity calls the seam) is recorded, with no profile.
    const account = (await device.api.getRecentEvents({ query: {} })).items;
    expect(account.map((item) => item.type)).toEqual(["auth.signin"]);
    expect(account[0]?.subject.profile).toBeNull();
  });

  it("refuses a client-supplied identity, a 51st event and a body over 64 KiB", async () => {
    const t = await createTestApp({ config: { WEBFLIX_CONSENT_MODE: "opt-out" } });
    const post = (body: unknown) =>
      t.request(`${API_BASE_PATH}/events`, {
        method: "POST",
        headers: CLIENT,
        body: JSON.stringify(body),
      });
    const forged = {
      ...event(),
      subject: {
        account: "aK3vB8nQ2wE5rT7yU9iO1p",
        profile: null,
        plan: "premium",
        country: "US",
        restricted: false,
        consent: { analytics: true, personalisation: true },
      },
    };
    const refused = await post({ events: [forged] });
    expect(refused.status).toBe(400);
    expect((await refused.json()).code).toBe("validation_failed");
    expect((await post({ events: [{ ...event(), source: "server" }] })).status).toBe(400);
    expect(
      (await post({ events: [{ ...event(), receivedAt: "2026-01-01T00:00:00.000Z" }] })).status,
    ).toBe(400);
    expect((await post({ events: Array.from({ length: 51 }, () => event()) })).status).toBe(400);
    const tooLarge = await t.request(`${API_BASE_PATH}/events`, {
      method: "POST",
      headers: CLIENT,
      body: JSON.stringify({ events: [event()], pad: "x".repeat(EVENT_BATCH_MAX_BYTES) }),
    });
    expect(tooLarge.status).toBe(413);
    // A server event type is not a client event.
    expect((await post({ events: [{ ...event(), type: "playback.start" }] })).status).toBe(400);
    // The version is pinned.
    expect((await post({ events: [{ ...event(), version: EVENT_VERSION + 1 }] })).status).toBe(400);
  });

  it("needs the client header like every mutation", async () => {
    const t = await createTestApp();
    const response = await t.request(`${API_BASE_PATH}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [event()] }),
    });
    expect(response.status).toBe(403);
  });

  it("limits each device, whatever its address", async () => {
    const t = await createTestApp({
      config: { WEBFLIX_CONSENT_MODE: "opt-out", WEBFLIX_RATE_LIMIT_EVENTS: "3/60" },
    });
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await t.request(`${API_BASE_PATH}/events`, {
        method: "POST",
        headers: { ...CLIENT, "X-Test-Ip": `198.51.100.${index + 1}` },
        body: JSON.stringify({ events: [event({ deviceId: "dev-flood" })] }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it("limits each account, whatever device it claims", async () => {
    const t = await createTestApp({
      config: { WEBFLIX_CONSENT_MODE: "opt-out", WEBFLIX_RATE_LIMIT_EVENTS: "3/60" },
    });
    const device = await demoOn(t, "pr-demo");
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await device.request(`${API_BASE_PATH}/events`, {
        method: "POST",
        headers: CLIENT,
        body: JSON.stringify({ events: [event({ deviceId: `dev-rotating-${index}` })] }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it("is implemented: the events area has no pending route left", async () => {
    const t = await createTestApp();
    const pending = pendingOperations(createHandlers(t.container));
    const events = [
      "ingestEvents",
      "getConsent",
      "updateConsent",
      "requestDataExport",
      "downloadDataExport",
      "listPrivacyRequests",
      "requestAccountDeletion",
      "cancelAccountDeletion",
      "getRecentEvents",
    ];
    expect(pending.filter((name) => events.includes(name))).toEqual([]);
  });
});

describe("consent over HTTP", () => {
  it("tells a signed-out visitor what applies, honouring Global Privacy Control", async () => {
    const t = await createTestApp({ config: { WEBFLIX_CONSENT_MODE: "opt-out" } });
    const plain = await t.device().api.getConsent();
    expect(plain).toMatchObject({ mode: "opt-out", gpc: false, promptRequired: false });
    expect(plain.purposes.analytics.granted).toBe(true);
    const response = await t.request(`${API_BASE_PATH}/privacy/consent`, {
      headers: { "Sec-GPC": "1" },
    });
    const withGpc = await response.json();
    expect(withGpc.gpc).toBe(true);
    expect(withGpc.purposes.analytics.granted).toBe(false);
  });

  it("records a signed-in answer for the account; a kids profile cannot answer", async () => {
    const t = await createTestApp();
    const adult = await demoOn(t, "pr-demo");
    const before = await adult.api.getConsent();
    expect(before).toMatchObject({ mode: "opt-in", promptRequired: true });
    const after = await adult.api.updateConsent({
      body: { purpose: "analytics", granted: true, source: "banner" },
    });
    expect(after.purposes.analytics).toMatchObject({ granted: true, source: "banner" });
    // Per account: another device of the account sees it.
    const other = await demoOn(t, "pr-demo");
    expect((await other.api.getConsent()).purposes.analytics.granted).toBe(true);
    const kids = await demoOn(t, "pr-kids");
    const refused = await kids.request(`${API_BASE_PATH}/privacy/consent`, {
      method: "PUT",
      headers: CLIENT,
      body: JSON.stringify({ purpose: "analytics", granted: true, source: "banner" }),
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("unrestricted_profile_required");
  });
});

describe("member rights over HTTP", () => {
  it("exports: a fresh proof, the job, the listed signed link, the download (and only for its owner)", async () => {
    const t = await createTestApp({ config: { WEBFLIX_CONSENT_MODE: "opt-out" } });
    const { device } = await onboard(t, { email: "export-me@example.com" });
    const refused = await device.request(`${API_BASE_PATH}/privacy/export`, {
      method: "POST",
      headers: CLIENT,
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("reauthentication_required");
    await elevate(t, device);
    const started = await device.api.requestDataExport();
    expect(started.status).toBe("pending");
    await t.queue.drain();
    const { items } = await device.api.listPrivacyRequests();
    const url = items[0]?.downloadUrl ?? "";
    expect(url).toMatch(/^\/api\/v1\/privacy\/exports\//);
    const download = await device.request(url);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="webflix-data-/,
    );
    const document = await download.json();
    expect(document.account.email).toBe("export-me@example.com");
    expect(document.format).toBe("webflix.data-export");
    // Another member with the very same link: not found.
    const { device: stranger } = await onboard(t, { email: "stranger@example.com" });
    expect((await stranger.request(url)).status).toBe(404);
    // Signed out: unauthenticated.
    expect((await t.request(url)).status).toBe(401);
  });

  it("deletes: a fresh proof, a scheduled request, cancellable; refused on the demo account", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "leaving@example.com" });
    const refused = await device.request(`${API_BASE_PATH}/account/deletion`, {
      method: "POST",
      headers: CLIENT,
    });
    expect((await refused.json()).code).toBe("reauthentication_required");
    await elevate(t, device);
    const scheduled = await device.api.requestAccountDeletion();
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.scheduledFor).not.toBeNull();
    await device.api.cancelAccountDeletion();
    expect((await device.api.listPrivacyRequests()).items[0]?.status).toBe("canceled");
    const demo = await demoOn(t, "pr-demo");
    await elevate(t, demo);
    const blocked = await demo.request(`${API_BASE_PATH}/account/deletion`, {
      method: "POST",
      headers: CLIENT,
    });
    expect((await blocked.json()).code).toBe("demo_account_protected");
  });

  it("while a deletion is scheduled the membership cannot renew again: 409 until it is kept", async () => {
    const t = await createTestApp();
    const device = t.device();
    await device.api.signup({
      body: { email: "renewal@example.com", password: "correct horse battery" },
    });
    const profile = await device.api.createProfile({ body: { name: "Me", avatarId: "av-fox" } });
    await device.api.selectProfile({ body: { profileId: profile.id } });
    const started = await device.api.startCheckout({ body: { planId: "basic" } });
    await t.ports.payments.confirmSetup(started.clientSecret ?? "", "visa");
    await device.api.confirmCheckout({ params: { id: started.id } });
    await t.queue.drain();
    await elevate(t, device);
    const deletion = await device.api.requestAccountDeletion();
    expect(deletion.membership?.status).toBe("ending");
    const post = (path: string, method: string, body?: unknown) =>
      device.request(`${API_BASE_PATH}${path}`, {
        method,
        headers: { ...CLIENT, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    for (const [path, method, body] of [
      ["/account/subscription/resume", "POST", undefined],
      ["/account/subscription", "PUT", { planId: "premium" }],
      ["/billing/checkout", "POST", { planId: "standard" }],
    ] as const) {
      const response = await post(path, method, body);
      expect(response.status, `${method} ${path}`).toBe(409);
      const problem = await response.json();
      expect(problem.code).toBe("account_deletion_scheduled");
      expect(problem.detail).toMatch(/Keep your account first/);
    }
    // Kept: resume works at once.
    await device.api.cancelAccountDeletion();
    const resumed = await device.api.resumeMembership();
    expect(resumed.subscription.status).not.toBe("canceling");
    expect((await device.api.getAccount()).membership?.cancelAtPeriodEnd).toBe(false);
  });
});

describe("playback events over HTTP", () => {
  it("start, release: the read-back shows playback.start and playback.abandon", async () => {
    const t = await createTestApp({ config: { WEBFLIX_CONSENT_MODE: "opt-out" } });
    const device = await demoOn(t, "pr-demo");
    const session = await device.api.createPlaybackSession({ body: { titleId: "t-lanterns" } });
    t.clock.advance(30_000);
    await device.api.sendHeartbeat({
      params: { id: session.id },
      body: { positionSec: 30, durationSec: session.durationSec, state: "playing" },
    });
    await device.api.endPlaybackSession({ params: { id: session.id } });
    await t.queue.drain();
    const types = (await device.api.getRecentEvents({ query: { profileId: "pr-demo" } })).items.map(
      (item) => item.type,
    );
    expect(types).toContain("playback.start");
    expect(types).toContain("playback.abandon");
  });
});
