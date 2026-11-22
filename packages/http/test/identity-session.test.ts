/**
 * `GET /session` carries the caller's experiment assignments (§8.1): the active profile is the
 * unit after sign-in, the `deviceId` query before it; targeting sees the plan the account holds
 * (none for an account without a membership, never the stand-in's) and when it joined.
 */
import type { ExperimentsService } from "@webflix/core";
import { describe, expect, it } from "vitest";
import { createTestApp, DEMO, onboard, type TestApp } from "./support.ts";

type SessionAssignmentInput = Parameters<ExperimentsService["sessionAssignments"]>[0];

function spyAssignments(t: TestApp) {
  const calls: SessionAssignmentInput[] = [];
  t.container.services.experiments.sessionAssignments = async (input) => {
    calls.push(input);
    return { "rows-ranking": input.profile ? "learned" : "rules" };
  };
  return calls;
}

describe("GET /session and experiment assignments", () => {
  it("assigns the device before sign-in", async () => {
    const t = await createTestApp();
    const calls = spyAssignments(t);
    const state = await t.device().api.getSession({ query: { deviceId: "device-123" } });
    expect(state).toEqual({ authenticated: false, experiments: { "rows-ranking": "rules" } });
    expect(calls).toEqual([{ profile: null, deviceId: "device-123", plan: null, joinedAt: null }]);
  });

  it("assigns the active profile after sign-in, with the plan held and the join time", async () => {
    const t = await createTestApp();
    const calls = spyAssignments(t);
    const { device, profileId } = await onboard(t, {
      email: "member@example.com",
      planId: "premium",
    });
    const state = await device.api.getSession({ query: { deviceId: "device-123" } });
    expect(state).toMatchObject({
      authenticated: true,
      experiments: { "rows-ranking": "learned" },
    });
    const [call] = calls.slice(-1);
    expect(call?.profile?.id).toBe(profileId);
    expect(call?.deviceId).toBe("device-123");
    expect(call?.plan).toBe("premium");
    expect(call?.joinedAt).toBe(t.clock.now());

    const demo = t.device();
    await demo.api.login({ body: DEMO });
    await demo.api.getSession({ query: {} });
    expect(calls.at(-1)).toMatchObject({ profile: null, deviceId: null, plan: "premium" });
  });

  it("targets no plan for an account without a membership", async () => {
    const t = await createTestApp();
    const calls = spyAssignments(t);
    const device = t.device();
    await device.api.signup({
      body: { email: "early@example.com", password: "correct horse battery" },
    });
    const state = await device.api.getSession({ query: {} });
    // No membership is exactly that: no subscription, no plan.
    expect(state).toMatchObject({ authenticated: true, subscription: null, plan: null });
    expect(calls.at(-1)).toMatchObject({ profile: null, plan: null, joinedAt: t.clock.now() });
  });
});
