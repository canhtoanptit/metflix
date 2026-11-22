/**
 * "Sign out of all devices" (`POST /auth/logout-all`) and signing one device out
 * (`DELETE /account/sessions/:id`) stop a device that is playing at its next request: its
 * heartbeat and playlists are refused, it cannot start again, and its stream slot is free.
 * Segments it already has a token for stay fetchable until the token expires (stateless by
 * design, docs/DECISIONS.md D1); the official player stops on the refused heartbeat.
 */
import { ApiError } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { createTestApp, type Device, onboard, SEGMENT_PATH, signIn } from "./support.ts";

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => (ApiError.is(error) ? error.code : String(error)),
  );
}

async function playing(device: Device) {
  const session = await device.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
  await device.api.sendHeartbeat({
    params: { id: session.id },
    body: { positionSec: 10, durationSec: 600, state: "playing" },
  });
  return session;
}

describe("signing devices out while one is playing", () => {
  for (const how of ["everywhere", "that device"] as const) {
    it(`stops it at its next request (${how})`, async () => {
      const t = await createTestApp();
      const { device: holder, profileId } = await onboard(t, {
        email: "family@example.com",
        planId: "basic",
      });
      const tv = await signIn(t, "family@example.com", "correct horse battery", "TV", profileId);
      const session = await playing(tv);
      const playlist = session.manifestUrl.replace("master.m3u8", "720p/index.m3u8");
      const segment = session.manifestUrl.replace("master.m3u8", SEGMENT_PATH);
      expect((await t.request(playlist)).status).toBe(200);

      if (how === "everywhere") {
        await holder.api.logoutAll();
      } else {
        const devices = await holder.api.listDevices();
        const target = devices.items.find((item) => !item.current);
        await holder.api.revokeDevice({ params: { id: target?.id ?? "" } });
      }

      expect(
        await codeOf(
          tv.api.sendHeartbeat({
            params: { id: session.id },
            body: { positionSec: 20, durationSec: 600, state: "playing" },
          }),
        ),
      ).toBe("unauthenticated");
      expect((await t.request(playlist)).status).toBe(410);
      expect(await codeOf(tv.api.createPlaybackSession({ body: { titleId: "t-orbit" } }))).toBe(
        "unauthenticated",
      );
      // Stateless until the token expires (6 h by default): the player has stopped by then.
      expect((await t.request(segment)).status).toBe(200);
      // The one Basic screen is free again.
      const phone = await signIn(
        t,
        "family@example.com",
        "correct horse battery",
        "Phone",
        profileId,
      );
      await phone.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    });
  }

  it("does nothing when asked from a device without a profile (403 profile_required)", async () => {
    const t = await createTestApp();
    const { profileId } = await onboard(t, { email: "family@example.com", planId: "basic" });
    const tv = await signIn(t, "family@example.com", "correct horse battery", "TV", profileId);
    const session = await playing(tv);
    // What the reviewer's script did: sign in elsewhere, ask without choosing a profile.
    const gate = await signIn(t, "family@example.com", "correct horse battery", "Laptop");
    expect(await codeOf(gate.api.logoutAll())).toBe("profile_required");
    await tv.api.sendHeartbeat({
      params: { id: session.id },
      body: { positionSec: 20, durationSec: 600, state: "playing" },
    });
  });
});
