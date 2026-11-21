/**
 * `DELETE /playback/sessions/:id` with the final position (the page-close path): one request
 * records where the member stopped and frees the slot, under every rule a heartbeat obeys.
 */
import { API_BASE_PATH, ApiError, CLIENT_HEADER, CLIENT_HEADER_VALUE } from "@webflix/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, DEMO, type Device, onboard, signIn, type TestApp } from "./support.ts";

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});

function release(device: Device, id: string, body?: unknown, contentType = "application/json") {
  return device.request(`${API_BASE_PATH}/playback/sessions/${id}`, {
    method: "DELETE",
    headers: {
      [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
      ...(body === undefined ? {} : { "Content-Type": contentType }),
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => (ApiError.is(error) ? error.code : String(error)),
  );
}

describe("releasing a playback session with its final position", () => {
  it("records the position and frees the slot in one request, even if no heartbeat arrives", async () => {
    const { device } = await onboard(t, { email: "close@example.com", planId: "basic" });
    const session = await device.api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
    t.clock.advance(40_000);
    // The tab closes: the release carries the position; the final heartbeat is never sent.
    await device.api.endPlaybackSession(
      { params: { id: session.id }, body: { positionSec: 40, durationSec: 600, state: "paused" } },
      { keepalive: true },
    );
    const list = await device.api.getContinueWatching();
    expect(list.items.find((item) => item.title.id === "t-lowlands")?.progress).toMatchObject({
      positionSec: 40,
      durationSec: 600,
    });
    // Released: the one Basic screen is free again, and the session is over.
    const next = await device.api.createPlaybackSession({ body: { titleId: "t-harvest" } });
    expect(
      await codeOf(
        device.api.sendHeartbeat({
          params: { id: session.id },
          body: { positionSec: 41, durationSec: 600, state: "playing" },
        }),
      ),
    ).toBe("playback_session_ended");
    await device.api.endPlaybackSession({ params: { id: next.id } });
  });

  it("applies the heartbeat's completion and credit rules", async () => {
    const { device } = await onboard(t, { email: "finale@example.com" });
    const session = await device.api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
    t.clock.advance(5_000);
    // Claims ten minutes in five seconds, at the end: finished, but credited five seconds.
    await device.api.endPlaybackSession({
      params: { id: session.id },
      body: { positionSec: 600, durationSec: 600, state: "ended" },
    });
    const detail = await device.api.getTitle({ params: { id: "t-lowlands" } });
    expect(detail.viewer.progress?.completed).toBe(true);
    const record = await t.deps.repos.playback.get(session.id);
    expect(record?.endedAt).toBe(t.clock.now());
    expect(record?.watchedSec).toBeCloseTo(5);
  });

  it("keeps the old behaviour without a body: idempotent and unconditional", async () => {
    const { device } = await onboard(t, { email: "plain@example.com" });
    const session = await device.api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
    expect((await release(device, session.id)).status).toBe(204);
    expect((await release(device, session.id)).status).toBe(204);
    expect((await release(device, "ps-unknown")).status).toBe(204);
  });

  it("cannot be used to report for someone else or after the slot was revoked", async () => {
    const owner = await signIn(t, DEMO.email, DEMO.password, "Owner/1.0", "pr-demo");
    const other = await signIn(t, DEMO.email, DEMO.password, "Other/1.0", "pr-kids");
    const session = await owner.api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
    const final = { positionSec: 90, durationSec: 600, state: "paused" } as const;

    // Another profile cannot record a position on this session.
    expect(
      await codeOf(other.api.endPlaybackSession({ params: { id: session.id }, body: final })),
    ).toBe("not_found");

    // Signing out everywhere revokes the slot: the final position is refused, like a heartbeat.
    const auth = await t.services.auth.authenticate(owner.cookies.get("webflix_session") ?? "");
    if (!auth) throw new Error("not signed in");
    await t.deps.streamGate.releaseAll(auth.session.accountId);
    expect(
      await codeOf(owner.api.endPlaybackSession({ params: { id: session.id }, body: final })),
    ).toBe("playback_session_ended");
    expect((await t.deps.repos.playback.get(session.id))?.positionSec).not.toBe(90);
    // Once ended, every later final report is refused too.
    expect(
      await codeOf(owner.api.endPlaybackSession({ params: { id: session.id }, body: final })),
    ).toBe("playback_session_ended");
  });

  it("validates the body exactly like a heartbeat", async () => {
    const { device } = await onboard(t, { email: "strict@example.com" });
    const session = await device.api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
    const invalid = await release(device, session.id, { positionSec: -1, state: "watching" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "validation_failed" });
    const malformed = await release(device, session.id, "{");
    expect(await malformed.json()).toMatchObject({ code: "bad_request" });
    const text = await release(device, session.id, "positionSec=1", "text/plain");
    expect(await text.json()).toMatchObject({ code: "unsupported_media_type" });
    // None of those ended the session.
    expect((await t.deps.repos.playback.get(session.id))?.endedAt).toBeNull();
  });
});
