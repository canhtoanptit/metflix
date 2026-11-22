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
import { cardsOfRow } from "./util.ts";

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
): Promise<{ created: ExperimentDefinition; requestIds: string[]; liveAt: number }> {
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
  equal(started.value.previousStatus ?? "draft", "draft", "previousStatus of a started draft");
  const answeredAt = Date.now();
  ctx.env.onDispose(async () => {
    await api
      .setExperimentStatus({
        params: { key },
        body: { status: "completed", reason: "smoke: done" },
      })
      .catch(() => undefined);
  });
  // When the experiment is live is the staff API's to say: `statusChangeAt`, the instant the
  // start takes effect on every replica (null: at once), and never before `startsAt`.
  const changeAt = started.value.statusChangeAt;
  const startsAt = started.value.startsAt;
  const liveAt = Math.max(
    changeAt ? Date.parse(changeAt) : answeredAt,
    startsAt ? Date.parse(startsAt) : answeredAt,
  );
  return { created: created.value, requestIds: [created.requestId, started.requestId], liveAt };
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

/**
 * Until `liveAt` nobody may be assigned (assignment follows the previous status everywhere: an
 * assignment now means an instance went live early); the probes are repeated while waiting.
 * Then a short margin for clocks, and the caller expects the assignment on the first request.
 */
async function awaitLive(
  ctx: CheckContext,
  liveAt: number,
  probes: { what: string; probe: () => Promise<string | undefined> }[],
): Promise<void> {
  let rounds = 0;
  while (Date.now() < liveAt) {
    for (const { what, probe } of probes) {
      const early = await probe();
      equal(early, undefined, `${what} before the start takes effect (statusChangeAt)`);
    }
    rounds += 1;
    await ctx.sleep(Math.min(2_000, Math.max(0, liveAt - Date.now())));
  }
  await ctx.sleep(LIVE_MARGIN_MS);
  if (rounds > 0) {
    ctx.note(
      `the start took effect at statusChangeAt (${rounds} probe rounds before it: none assigned)`,
    );
  }
}

/** Clock difference between the suite and the deployment that the instant is allowed. */
const LIVE_MARGIN_MS = 2_000;

export const experimentChecks: CheckDefinition[] = [
  {
    id: "experiments.assignment",
    area: "experiments",
    title:
      "Experiment assignment travels in GET /session from the instant the staff API states (statusChangeAt; nobody assigned before it), then at once and stable for a profile across devices and for an anonymous device, spread over the variants, never given to a kids profile",
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
      // The units, ready before the experiments start, so the time before they are live is probed.
      const viewer = await ctx.env.isolatedViewer("experiments");
      const visitor = ctx.agent("experiments-visitor");
      const firstDevice = `smk-${run}-device-0`;
      const profileExperiment = await runningExperiment(ctx, api, profileKey, "profile");
      const deviceExperiment = await runningExperiment(ctx, api, deviceKey, "device");
      await awaitLive(ctx, Math.max(profileExperiment.liveAt, deviceExperiment.liveAt), [
        { what: "the profile's assignment", probe: () => assignment(viewer.agent, profileKey) },
        {
          what: "the device's assignment",
          probe: () => assignment(visitor, deviceKey, firstDevice),
        },
      ]);

      // The profile is the unit after sign-in: assigned on the first request once live, the same
      // variant on every device and request.
      const variant = await assignment(viewer.agent, profileKey);
      check(variant, "the profile is not assigned once the experiment is live", {
        expected: `a variant of ${profileKey} on the first GET /session after statusChangeAt`,
        observed: "no assignment",
      });
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
      for (let index = 0; index < 4; index += 1) {
        equal(
          await assignment(index % 2 === 0 ? viewer.agent : second, profileKey),
          variant,
          `the profile's variant on later request ${index + 1}`,
        );
      }
      // Never a restricted profile (§6.3, §8.1).
      const kids = await ctx.env.createProfile(viewer.account.agent, { name: "Kid", isKids: true });
      const kidsDevice = await ctx.env.login(viewer.account, "experiments-kids");
      await ctx.env.selectProfile(kidsDevice, kids.id);
      equal(await assignment(kidsDevice, profileKey), undefined, "a kids profile's assignment");

      // Before sign-in the device is the unit: assigned at once, stable per device, spread
      // across devices.
      const deviceVariant = await assignment(visitor, deviceKey, firstDevice);
      check(deviceVariant, "the device is not assigned once the experiment is live", {
        expected: `a variant of ${deviceKey} on the first GET /session?deviceId= after statusChangeAt`,
        observed: "no assignment",
      });
      equal(
        await assignment(ctx.agent("experiments-visitor-2"), deviceKey, firstDevice),
        deviceVariant,
        "the same device's variant from another connection",
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
      "The served recommendation model and its last import are visible to admin staff only; with a model imported, a new profile gets the rule engine's page, labelled rules (never learned or neighbours), and no Top Picks",
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
          "no recommendation run is imported (GET /system/recommendations: activeModel null): learned serving needs a pipeline run (make recs) published to the blob store and imported: node apps/api/src/recs.ts import on Node (or POST /system/recommendations/import), make cf-recs-import on Cloudflare (a run larger than one Worker invocation is refused by the route with recommendation_import_too_large)",
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
      // A profile with no history: the model never saw it and has nothing for it, so the page
      // is the rule engine's, labelled `rules` (never `learned:` or `neighbours:`), the same
      // page another new profile gets.
      const cold = await ctx.env.isolatedViewer("recs-cold");
      const twin = await ctx.env.isolatedViewer("recs-cold-twin");
      const page = await succeeds(
        () => cold.agent.api.getBrowse({ query: { view: "home" } }),
        "GET /browse (a new profile)",
      );
      const twinPage = await succeeds(
        () => twin.agent.api.getBrowse({ query: { view: "home" } }),
        "GET /browse (another new profile)",
      );
      equal(page.policy?.id, "rules", "the ranking policy of a profile with no history");
      check(
        !page.rows.some((row) => row.kind === "top-picks"),
        "a profile the model never scored has a Top Picks row",
        { observed: page.rows.map((row) => row.kind).join(", ") },
      );
      if (page.policy?.explore || twinPage.policy?.explore) {
        ctx.note(
          "an exploration page (random order): the two new profiles' pages are not compared",
        );
      } else {
        // The billboard rotates daily per profile among the engine's best few (by design), so
        // the rows are what two new profiles share.
        const shape = (current: typeof page) =>
          JSON.stringify(
            current.rows.map((row) => [row.kind, cardsOfRow(row).map((card) => card.id)]),
          );
        equal(
          shape(page),
          shape(twinPage),
          "a new profile's rows vs another new profile's (the rule engine's)",
        );
      }
      ctx.note(`serving run ${model.run}, expires ${model.expiresAt}`);
    },
  },
];
