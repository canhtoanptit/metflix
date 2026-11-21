/**
 * Routes whose body is optional (`DELETE /playback/sessions/:id`, `DELETE /profiles/:id`): an
 * empty or whitespace-only body is no body, whatever `Content-Type` and `Content-Length` say.
 * Clients that add `Content-Type: application/json` to every request must not get a 400.
 */
import { API_BASE_PATH, CLIENT_HEADER, CLIENT_HEADER_VALUE } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { createTestApp, type Device, onboard } from "./support.ts";

function send(
  device: Device,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
) {
  return device.request(`${API_BASE_PATH}${path}`, {
    method,
    headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE, ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

const EMPTY_BODIES: Array<[string, Record<string, string>, string | undefined]> = [
  ["JSON type, no body", { "Content-Type": "application/json" }, undefined],
  ["JSON type, empty body", { "Content-Type": "application/json" }, ""],
  [
    "JSON type, Content-Length: 0",
    { "Content-Type": "application/json", "Content-Length": "0" },
    "",
  ],
  ["JSON type, whitespace only", { "Content-Type": "application/json" }, " \r\n\t "],
  ["other type, whitespace only", { "Content-Type": "text/plain;charset=UTF-8" }, "\n"],
  ["no type, Content-Length: 0", { "Content-Length": "0" }, ""],
];

describe("an empty body where the body is optional", () => {
  it.each(EMPTY_BODIES)("ends a playback session: %s", async (_name, headers, body) => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "empty@example.com" });
    const session = await device.api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
    const response = await send(
      device,
      "DELETE",
      `/playback/sessions/${session.id}`,
      headers,
      body,
    );
    expect(response.status, await response.clone().text()).toBe(204);
    expect((await t.deps.repos.playback.get(session.id))?.endedAt).toBe(t.clock.now());
  });

  it.each(EMPTY_BODIES)("deletes a profile: %s", async (_name, headers, body) => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "empty@example.com" });
    const extra = await device.api.createProfile({ body: { name: "Extra", avatarId: "av-owl" } });
    const response = await send(device, "DELETE", `/profiles/${extra.id}`, headers, body);
    expect(response.status, await response.clone().text()).toBe(204);
  });

  it("still checks whatever is sent", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "sent@example.com" });
    const session = await device.api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
    const path = `/playback/sessions/${session.id}`;
    const json = { "Content-Type": "application/json" };
    expect(await (await send(device, "DELETE", path, json, "{")).json()).toMatchObject({
      code: "bad_request",
    });
    expect(
      await (await send(device, "DELETE", path, { "Content-Type": "text/plain" }, "{}")).json(),
    ).toMatchObject({ code: "unsupported_media_type" });
    expect(
      await (await send(device, "DELETE", path, json, '{"positionSec":-1}')).json(),
    ).toMatchObject({ code: "validation_failed" });
  });

  it("is still required where the body is required", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "required@example.com" });
    const response = await send(
      device,
      "POST",
      "/playback/sessions",
      { "Content-Type": "application/json" },
      " ",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "bad_request" });
  });
});
