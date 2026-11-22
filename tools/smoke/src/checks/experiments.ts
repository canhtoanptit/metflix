/**
 * Experimentation and recommendation serving (docs/BLUEPRINT-M2.md §7.2, §8.1): deterministic
 * assignment carried in `GET /session` (the profile, or the device before sign-in), never for a
 * restricted profile; and the served recommendation model as staff see it. The suite defines its
 * own experiments in their own layers through the staff API and ends them afterwards.
 */
import type { AdminApiClient, ExperimentDefinition, StaffRole } from "@webflix/contracts";
import { check, equal, rejects, succeeds } from "../expect.ts";
import type { Agent } from "../http.ts";
import { needs } from "../needs.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { audited, auditOf, expectAudited, staffClient, subjectOf } from "./staff.ts";

const VARIANTS = ["control", "treatment"] as const;

function definition(key: string, unit: "profile" | "device", reason: string) {
  return {
    key,
    name: `Smoke ${unit} assignment ${key}`,
    description: "Created by the conformance suite; ended when it finishes.",
    unit,
    layer: key.replaceAll(".", "-"),
    allocation: { start: 0, end: 10_000 },
    targeting: { percentage: 100, plans: [], countries: [], audience: "all" as const },
    variants: VARIANTS.map((name) => ({ name, weight: 1 })),
    control: "control",
    primaryMetric: "qualified_plays" as const,
    secondaryMetrics: [],
    alpha: 0.05,
    power: 0.8,
    minimumDetectableEffect: 0.05,
    startsAt: null,
    endsAt: null,
    srmThreshold: 0.001,
    reason,
  };
}

/** Start an experiment; it is completed when the run ends, whatever happens. */
async function runningExperiment(
  ctx: CheckContext,
  api: AdminApiClient,
  key: string,
  unit: "profile" | "device",
): Promise<{ created: ExperimentDefinition; requestIds: string[] }> {
  const created = await audited(
    () => api.createExperiment({ body: definition(key, unit, "smoke: assignment check") }),
    `POST /experiments (${key})`,
  );
  equal(created.value.status, "draft", "a new experiment's status");
  const started = await audited(
    () =>
      api.setExperimentStatus({
        params: { key },
        body: { status: "running", reason: "smoke: start" },
      }),
    `PUT /experiments/${key}/status running`,
  );
  equal(started.value.status, "running", "status after starting");
  ctx.env.onDispose(async () => {
    await api
      .setExperimentStatus({
        params: { key },
        body: { status: "completed", reason: "smoke: done" },
      })
      .catch(() => undefined);
  });
  return { created: created.value, requestIds: [created.requestId, started.requestId] };
}

async function assignment(
  agent: Agent,
  key: string,
  deviceId?: string,
): Promise<string | undefined> {
  const state = await succeeds(
    () => agent.api.getSession(deviceId ? { query: { deviceId } } : undefined),
    "GET /session",
  );
  return state.experiments?.[key];
}

/** Poll until the session carries an assignment for `key` (definitions are cached briefly). */
async function awaitAssignment(
  ctx: CheckContext,
  agent: Agent,
  key: string,
  deviceId?: string,
): Promise<string> {
  const { value, elapsedMs } = await ctx.eventually(
    `an assignment to ${key} in GET /session`,
    async () => {
      const variant = await assignment(agent, key, deviceId);
      return variant ? { done: true, value: variant } : { done: false, observed: "not assigned" };
    },
    { timeoutMs: 100_000, intervalMs: 1_000 },
  );
  if (elapsedMs > 2_000)
    ctx.note(`the new experiment reached sessions after ${Math.round(elapsedMs / 1000)} s`);
  return value;
}

export const experimentChecks: CheckDefinition[] = [
  {
    id: "experiments.assignment",
    area: "experiments",
    title:
      "Experiment assignment travels in GET /session: stable for a profile across devices and for an anonymous device, spread over the variants across units, never given to a kids profile",
    needs: [needs.staffIssuer],
    tags: ["exclusive"],
    timeoutMs: 300_000,
    async run(ctx: CheckContext) {
      const api = await staffClient(ctx, "experiments");
      const admin = await staffClient(ctx, "admin");
      const actorId = await subjectOf(api);
      const run = ctx.options.runId;
      const profileKey = `smoke.profile-${run}`;
      const deviceKey = `smoke.device-${run}`;
      const profileExperiment = await runningExperiment(ctx, api, profileKey, "profile");
      await runningExperiment(ctx, api, deviceKey, "device");

      // The profile is the unit after sign-in: the same variant on every device and request.
      const viewer = await ctx.env.isolatedViewer("experiments");
      const variant = await awaitAssignment(ctx, viewer.agent, profileKey);
      check(
        (VARIANTS as readonly string[]).includes(variant),
        "an assignment outside the variants",
        {
          observed: variant,
        },
      );
      const second = await ctx.env.login(viewer.account, "experiments-second-device");
      await ctx.env.selectProfile(second, viewer.profile.id);
      equal(
        await assignment(second, profileKey),
        variant,
        "the profile's variant on another device",
      );
      equal(
        await assignment(viewer.agent, profileKey),
        variant,
        "the profile's variant on a later request",
      );
      // Never a restricted profile (§6.3, §8.1).
      const kids = await ctx.env.createProfile(viewer.account.agent, { name: "Kid", isKids: true });
      const kidsDevice = await ctx.env.login(viewer.account, "experiments-kids");
      await ctx.env.selectProfile(kidsDevice, kids.id);
      equal(await assignment(kidsDevice, profileKey), undefined, "a kids profile's assignment");

      // Before sign-in the device is the unit: stable per device, spread across devices.
      const visitor = ctx.agent("experiments-visitor");
      const firstDevice = `smk-${run}-device-0`;
      const deviceVariant = await awaitAssignment(ctx, visitor, deviceKey, firstDevice);
      equal(
        await assignment(visitor, deviceKey, firstDevice),
        deviceVariant,
        "the same device's variant again",
      );
      const seen = new Map<string, number>();
      for (let index = 0; index < 32; index += 1) {
        const assigned = await assignment(visitor, deviceKey, `smk-${run}-device-${index}`);
        check(assigned, `device ${index} is not assigned`);
        seen.set(assigned, (seen.get(assigned) ?? 0) + 1);
      }
      check(
        seen.size === VARIANTS.length,
        "32 devices all landed in one variant (assignment ignores the unit?)",
        {
          observed: JSON.stringify(Object.fromEntries(seen)),
        },
      );
      ctx.note(`32 devices: ${JSON.stringify(Object.fromEntries(seen))}`);
      equal(
        await assignment(visitor, profileKey, firstDevice),
        undefined,
        "a profile experiment for an anonymous device",
      );

      const entries = await auditOf(admin, { targetId: profileKey });
      expectAudited(
        entries,
        [
          {
            requestId: profileExperiment.requestIds[0] ?? "",
            reason: "smoke: assignment check",
            what: "creating the experiment",
          },
          {
            requestId: profileExperiment.requestIds[1] ?? "",
            reason: "smoke: start",
            what: "starting it",
          },
        ],
        actorId,
      );
    },
  },
  {
    id: "experiments.recommendation-status",
    area: "experiments",
    title:
      "The served recommendation model and its last import are visible to admin staff only; with a model imported, a new profile still gets the rule engine (cold start)",
    needs: [needs.staffIssuer],
    async run(ctx: CheckContext) {
      const admin = await staffClient(ctx, "admin");
      const status = await succeeds(
        () => admin.getRecommendationStatus(),
        "GET /system/recommendations",
      );
      for (const role of ["content", "experiments", "support"] satisfies StaffRole[]) {
        const api = await staffClient(ctx, role);
        const refused = await rejects(
          () => api.getRecommendationStatus(),
          "staff_role_required",
          `GET /system/recommendations as ${role}`,
        );
        equal(refused.problem.requiredRole, "admin", "requiredRole");
      }
      if (status.lastImport)
        ctx.note(`last import: ${status.lastImport.run} ${status.lastImport.status}`);
      if (!status.activeModel) {
        ctx.skip(
          "no recommendation run is imported (GET /system/recommendations: activeModel null): learned serving needs a pipeline run (make recs) published to the blob store and imported (node apps/api/src/recs.ts import, or POST /system/recommendations/import)",
        );
      }
      const model = status.activeModel;
      check(Date.parse(model.asOf) <= Date.now(), "the model is dated in the future", {
        observed: model.asOf,
      });
      check(
        Date.parse(model.importedAt) >= Date.parse(model.asOf),
        "imported before it was built",
        {
          observed: JSON.stringify(model),
        },
      );
      const viewer = await ctx.env.isolatedViewer("recs-cold");
      const page = await succeeds(
        () => viewer.agent.api.getBrowse({ query: { view: "home" } }),
        "GET /browse",
      );
      equal(
        page.policy?.id,
        "rules",
        "the ranking policy of a profile the model never saw (cold start)",
      );
      ctx.note(`serving run ${model.run}, expires ${model.expiresAt}`);
    },
  },
];
