/**
 * Composition: an app is never built over a rate-limit table that lacks a policy the contract
 * names. It fails when it is composed, with a `ConfigError`, not with a 500 on the first request.
 */
import { ConfigError } from "@webflix/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.ts";
import { createTestApp } from "./support.ts";

describe("composing the app", () => {
  it("refuses a configuration without every rate-limit policy", async () => {
    const t = await createTestApp();
    const { "playback-start": _dropped, ...rateLimits } = t.container.config.rateLimits;
    const config = { ...t.container.config, rateLimits } as typeof t.container.config;
    expect(() => createApp({ ...t.container, config })).toThrow(ConfigError);
    expect(() => createApp({ ...t.container, config })).toThrow(/playback-start/);
  });
});
