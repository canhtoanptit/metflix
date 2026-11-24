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
 * Until its own `liveAt` nobody may be assigned to an experiment (assignment follows the previous
 * status everywhere: an assignment before it means an instance went live early). Each experiment
 * is probed only until its own instant less the clock tolerance, and an answer that arrives
 * within that tolerance of the instant counts as neither early nor late. Then the suite waits
 * out the tolerance after the last instant, and the caller expects the assignment on the first
 * request.
 */
async function awaitLive(
  ctx: CheckContext,
  probes: { what: string; liveAt: number; probe: () => Promise<string | undefined> }[],
): Promise<void> {
  let rounds = 0;
  for (;;) {
    const open = probes.filter((item) => Date.now() < item.liveAt - LIVE_MARGIN_MS);
    if (open.length === 0) break;
    for (const { what, liveAt, probe } of open) {
      const early = await probe();
      if (Date.now() >= liveAt - LIVE_MARGIN_MS) continue; // within the tolerance of the instant
      equal(
        early,
        undefined,
        `${what} before the start takes effect (statusChangeAt ${new Date(liveAt).toISOString()})`,
      );
    }
    rounds += 1;
    const next = Math.min(...open.map((item) => item.liveAt - LIVE_MARGIN_MS)) - Date.now();
    await ctx.sleep(Math.min(2_000, Math.max(0, next)));
  }
  const last = Math.max(...probes.map((item) => item.liveAt));
  await ctx.sleep(Math.max(0, last + LIVE_MARGIN_MS - Date.now()));
  if (rounds > 0) {
    ctx.note(
      `the starts took effect at statusChangeAt (${rounds} probe rounds before them, each experiment probed until ${LIVE_MARGIN_MS} ms before its own instant: none assigned)`,
    );
  }
}

/** Clock difference between the suite and the deployment that the instant is allowed. */
const LIVE_MARGIN_MS = 2_000;

/** How long a process may serve from a copy of the consent withdrawals older than one (the
 * serving copy's age bound, `MODEL_MAX_AGE_MS`). */
const WITHDRAWAL_BOUND_MS = 30_000;

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
      const viewer = await ctx.env.isolatedViewer("experiments", { member: false });
      const visitor = ctx.agent("experiments-visitor");
      const firstDevice = `smk-${run}-device-0`;
      const profileExperiment = await runningExperiment(ctx, api, profileKey, "profile");
      const deviceExperiment = await runningExperiment(ctx, api, deviceKey, "device");
      await awaitLive(ctx, [
        {
          what: "the profile's assignment",
          liveAt: profileExperiment.liveAt,
          probe: () => assignment(viewer.agent, profileKey),
        },
        {
          what: "the device's assignment",
          liveAt: deviceExperiment.liveAt,
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
      // Asking for an import says what it did; only `queued` queues anything.
      const asked = await succeeds(
        () => admin.importRecommendations({ body: { reason: "smoke: what would an import do" } }),
        "POST /system/recommendations/import",
      );
      ctx.note(`import: ${asked.outcome}${asked.run ? ` (published run ${asked.run})` : ""}`);
      if (asked.outcome === "already_served")
        equal(asked.run, status.activeModel?.run ?? null, "the run already served");
      if (asked.outcome !== "queued") {
        const after = await succeeds(
          () => admin.getRecommendationStatus(),
          "GET /system/recommendations",
        );
        equal(
          after.activeModel?.run ?? null,
          status.activeModel?.run ?? null,
          "the served run after an import that queued nothing",
        );
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
      const cold = await ctx.env.isolatedViewer("recs-cold", { member: false });
      const twin = await ctx.env.isolatedViewer("recs-cold-twin", { member: false });
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
  {
    id: "personalisation.consent",
    area: "personalisation",
    title:
      "Serving follows consent and restriction: with a fresh model served, a member who turns personalisation off gets the rule engine's page (rules, no Top Picks) within 30 s and keeps it, and the model's label back within 30 s of turning it on; a demo run is never labelled learned or neighbours; a profile made kids gets rules",
    needs: [needs.staffIssuer, needs.fakePayments],
    timeoutMs: 300_000,
    async run(ctx: CheckContext) {
      const admin = await staffClient(ctx, "admin");
      const status = await succeeds(
        () => admin.getRecommendationStatus(),
        "GET /system/recommendations",
      );
      const model = status.activeModel;
      if (!model || Date.parse(model.expiresAt) <= Date.now()) {
        ctx.skip(
          `no fresh recommendation model is served (GET /system/recommendations: ${model ? `run ${model.run} expired at ${model.expiresAt}` : "activeModel null"}): serving a model needs a fresh pipeline run imported (make recs, then node apps/api/src/recs.ts import on Node, make cf-recs-import on Cloudflare), or for a demo node apps/api/src/recs.ts demo (labelled demo:…, fresh for three days)`,
        );
      }
      const demo = model.run.endsWith(DEMO_RUN_SUFFIX);
      const modelLabels = demo
        ? [`demo:${model.run}`]
        : [`learned:${model.run}`, `neighbours:${model.run}`];
      const account = await ctx.env.signup("personalisation", { plan: "standard" });
      const agent = await ctx.env.holder(account);
      const consent = await succeeds(() => agent.api.getConsent(), "GET /privacy/consent");
      if (consent.mode === "off") {
        ctx.skip("the consent mode is off (WEBFLIX_CONSENT_MODE): there is no answer to withdraw");
      }
      const answer = (granted: boolean) =>
        succeeds(
          () =>
            agent.api.updateConsent({
              body: { purpose: "personalisation", granted, source: "settings" },
            }),
          `PUT /privacy/consent (personalisation ${granted ? "on" : "off"})`,
        );
      const seen = new Set<string>();
      const page = async (what: string) => {
        const current = await succeeds(
          () => agent.api.getBrowse({ query: { view: "home" } }),
          `GET /browse (${what})`,
        );
        const id = current.policy?.id ?? "(no policy)";
        seen.add(id);
        return {
          id,
          topPicks: current.rows.some((row) => row.kind === "top-picks"),
        };
      };
      const shows = (what: string, wanted: (state: { id: string; topPicks: boolean }) => boolean) =>
        ctx.eventually(
          what,
          async () => {
            const current = await page(what);
            return wanted(current)
              ? { done: true, value: current }
              : {
                  done: false,
                  observed: `${current.id}${current.topPicks ? " with Top Picks" : ""}`,
                };
          },
          { timeoutMs: 30_000, intervalMs: 1_000 },
        );
      await answer(true);
      // A recent play gives the model something of its own to add (the neighbours of the title).
      const { cards } = await ctx.env.catalog();
      const title = cards.find((card) => card.type === "movie");
      check(title, "the catalogue has no movie");
      const played = await succeeds(
        () => agent.api.createPlaybackSession({ body: { titleId: title.id } }),
        "POST /playback/sessions",
      );
      await succeeds(
        () =>
          agent.api.sendHeartbeat({
            params: { id: played.id },
            body: { positionSec: 300, durationSec: played.durationSec, state: "playing" },
          }),
        "a heartbeat five minutes in",
      );
      await succeeds(
        () => agent.api.endPlaybackSession({ params: { id: played.id } }),
        "stop playback",
      );
      const labelled = async (what: string) => {
        try {
          return await shows(what, (state) => modelLabels.includes(state.id));
        } catch (error) {
          if (demo) throw error;
          // A trained model may know nothing of the title played: nothing to withdraw then.
          ctx.skip(
            `the served model (${model.run}) contributes nothing to a new member's page after a play (the page stays ${[...seen].join(", ")}): the withdrawal cannot be told apart from the rule engine's page`,
          );
        }
      };
      await labelled(`the page names the served model (${modelLabels.join(" or ")})`);

      // Turned off: the rule engine's page within the bound, and it stays so. The process that
      // records the withdrawal applies it at once and every other within 30 s, the age bound of
      // its copy of the withdrawals (docs/RECOMMENDATIONS.md, "consent"): behind several replicas
      // a request may still meet a copy older than the withdrawal until then, so the page is
      // held to the rule engine's from 30 s after the answer on.
      await answer(false);
      const withdrawnAt = Date.now();
      const off = await shows(
        "the rule engine's page after turning personalisation off (rules, no Top Picks)",
        (state) => state.id === "rules" && !state.topPicks,
      );
      ctx.note(`rules ${Math.round(off.elapsedMs / 1000)} s after turning personalisation off`);
      const early = new Set<string>();
      while (Date.now() < withdrawnAt + WITHDRAWAL_BOUND_MS) {
        await ctx.sleep(
          Math.min(5_000, Math.max(0, withdrawnAt + WITHDRAWAL_BOUND_MS - Date.now())),
        );
        const current = await page("personalisation off, within the bound");
        if (current.id !== "rules" || current.topPicks) early.add(current.id);
      }
      if (early.size > 0) {
        ctx.note(
          `within ${WITHDRAWAL_BOUND_MS / 1000} s of the withdrawal a copy older than it still answered ${[...early].join(", ")} (another replica), as documented`,
        );
      }
      const holdUntil = Date.now() + 35_000;
      while (Date.now() < holdUntil) {
        await ctx.sleep(5_000);
        const current = await page("personalisation off");
        check(
          current.id === "rules" && !current.topPicks,
          "the model came back while personalisation is off",
          {
            expected: "rules, no Top Picks",
            observed: `${current.id}, Top Picks ${current.topPicks}`,
          },
        );
      }
      // Turned on again: the model's label is back.
      await answer(true);
      await shows("the served model's label after turning personalisation on again", (state) =>
        modelLabels.includes(state.id),
      );

      // A demo run is not a trained model: no page says learned or neighbours.
      if (demo) {
        const demoViewer = await ctx.env.demo();
        const viewer = demoViewer.available ? demoViewer.viewer : undefined;
        if (viewer) {
          const demoPage = await succeeds(
            () => viewer.agent.api.getBrowse({ query: { view: "home" } }),
            "GET /browse (the demo account)",
          );
          seen.add(demoPage.policy?.id ?? "(no policy)");
        }
        const misleading = [...seen].filter((id) => /^(learned|neighbours):/.test(id));
        check(misleading.length === 0, "a demo run is labelled as a trained model", {
          expected: `demo:${model.run} (or rules)`,
          observed: misleading.join(", "),
        });
      }

      // A profile made kids: the rule engine's page, whatever the model holds.
      const session = await succeeds(() => agent.api.getSession(), "GET /session");
      const profileId = session.authenticated ? session.activeProfile?.id : undefined;
      check(profileId, "no active profile");
      await succeeds(
        () => agent.api.updateProfile({ params: { id: profileId }, body: { isKids: true } }),
        "PATCH /profiles/:id {isKids: true}",
      );
      const kids = await page("the profile made kids");
      equal(kids.id, "rules", "the policy of a profile made kids");
      equal(kids.topPicks, false, "Top Picks on a profile made kids");
      ctx.note(
        `model ${model.run}${demo ? " (a demo run)" : ""}; labels seen: ${[...seen].join(", ")}`,
      );
    },
  },
];

/** The run id suffix of a demo recommendation run (`node apps/api/src/recs.ts demo`). */
const DEMO_RUN_SUFFIX = "-de00de00";
