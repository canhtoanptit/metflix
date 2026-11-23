/**
 * Milestone 2 behaviour collection and privacy (docs/BLUEPRINT-M2.md §6): events accepted,
 * stamped by the server and readable back; nothing from a kids profile; consent as the
 * deployment's mode says; the data export; account deletion with its cooling-off period.
 * Events are read back through `GET /diagnostics/events` (non-production).
 */
import {
  ADMIN_API_BASE_PATH,
  type ClientEventInput,
  type ConsentState,
  DataExport,
  ERASED_MEMBER_LABEL,
  type LakeEvent,
  type PrivacyRequest,
  type PrivacyTerms,
  type RecentEventsQuery,
} from "@webflix/contracts";
import type { TestAccount } from "../env.ts";
import { check, equal, fail, problem, rejects, status, succeeds } from "../expect.ts";
import { type Agent, isApiError } from "../http.ts";
import { awaitMail, mailboxNow } from "../mail.ts";
import { needs } from "../needs.ts";
import { STAFF_PERSONAS } from "../oidc.ts";
import {
  advancePast,
  confirmCard,
  labelledCard,
  paidMembership,
  RENEWAL_SETTLE_SEC,
  subscribe,
} from "../payments.ts";
import { deviceId, EventStream } from "../telemetry.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { spentCard } from "./billing.ts";
import { audited, auditOf, staffClient } from "./staff.ts";
import { API, CSRF, maturityRank, unique } from "./util.ts";

const SUBJECT_KEY = /^[A-Za-z0-9_-]{22}$/;

/** `GET /diagnostics/events` for the agent's account; skips where the deployment has none. */
async function readBack(
  ctx: CheckContext,
  agent: Agent,
  query: RecentEventsQuery,
): Promise<LakeEvent[]> {
  try {
    return (await agent.api.getRecentEvents({ query })).items;
  } catch (error) {
    if (isApiError(error, "not_found")) {
      ctx.skip(
        "the events read-back is not served (GET /diagnostics/events → not_found): it is a non-production diagnostics surface (WEBFLIX_ENV other than production)",
      );
    }
    return succeeds(() => Promise.reject(error), "GET /diagnostics/events");
  }
}

/** Poll the read-back until `done` holds for what it returns. */
async function readBackUntil(
  ctx: CheckContext,
  agent: Agent,
  query: RecentEventsQuery,
  what: string,
  done: (events: LakeEvent[]) => boolean,
): Promise<LakeEvent[]> {
  const { value } = await ctx.eventually(what, async () => {
    const events = await readBack(ctx, agent, query);
    return done(events)
      ? { done: true, value: events }
      : {
          done: false,
          observed: `${events.length} events: ${events.map((event) => event.type).join(", ") || "none"}`,
        };
  });
  return value;
}

async function consentOf(agent: Agent, headers?: Record<string, string>): Promise<ConsentState> {
  return succeeds(
    () => agent.api.getConsent(undefined, headers ? { headers } : undefined),
    "GET /privacy/consent",
  );
}

async function grantAll(agent: Agent): Promise<void> {
  for (const purpose of ["analytics", "personalisation"] as const) {
    await succeeds(
      () => agent.api.updateConsent({ body: { purpose, granted: true, source: "banner" } }),
      `PUT /privacy/consent (grant ${purpose})`,
    );
  }
}

/** An account with a Standard membership (the subject's plan) and its holder profile. */
async function member(ctx: CheckContext, tag: string): Promise<TestAccount> {
  const account = await ctx.env.signup(tag, { plan: "standard" });
  await ctx.env.holder(account);
  return account;
}

async function anyTitle(ctx: CheckContext, kidsSafe = false): Promise<string> {
  const { cards } = await ctx.env.catalog();
  const card = cards.find(
    (candidate) =>
      candidate.type === "movie" &&
      (!kidsSafe || maturityRank(candidate.maturity) <= maturityRank("7+")),
  );
  check(card, kidsSafe ? "no movie rated 7+ or below" : "no movie");
  return card.id;
}

/** The pipeline's export-events results document with the audit reason. */
function resultsDocument(results: Record<string, unknown>[], reason: string) {
  return {
    format: "webflix.export-events-results" as const,
    formatVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    results: results.map((result) =>
      Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined)),
    ) as never,
    reason,
  };
}

/**
 * The export's parts from each area (privacy review M6): identity; billing with the checkouts
 * (never a client secret) and the promo codes used; personalisation's recommendation lists and
 * when personalisation was turned off; admin's record of staff access, each item exactly the
 * date and the action (never who or why).
 */
function assertExportAreas(areas: Record<string, unknown>, staffRead: boolean): void {
  const part = (name: string): Record<string, unknown> => {
    const value = areas[name];
    check(
      typeof value === "object" && value !== null && !Array.isArray(value),
      `export: areas.${name} is missing`,
      { observed: `areas: ${Object.keys(areas).join(", ") || "none"}` },
    );
    return value as Record<string, unknown>;
  };
  const listOf = (owner: Record<string, unknown>, name: string, where: string): unknown[] => {
    const value = owner[name];
    check(Array.isArray(value), `export: ${where}.${name} is not a list`, {
      observed: JSON.stringify(value ?? null).slice(0, 200),
    });
    return value;
  };
  part("identity");
  const billing = part("billing");
  const checkouts = listOf(billing, "checkouts", "areas.billing") as {
    id?: unknown;
    clientSecret?: unknown;
  }[];
  check(
    checkouts.length > 0,
    "export: the member's checkout is missing from areas.billing.checkouts",
  );
  check(
    checkouts.every((item) => item.clientSecret === null),
    "export: a checkout carries a client secret",
    { observed: JSON.stringify(checkouts).slice(0, 300) },
  );
  listOf(billing, "promotionCodes", "areas.billing");
  const personalisation = part("personalisation");
  listOf(personalisation, "recommendationLists", "areas.personalisation");
  check(
    "personalisationWithdrawnAt" in personalisation,
    "export: areas.personalisation.personalisationWithdrawnAt is missing",
    { observed: Object.keys(personalisation).join(", ") },
  );
  const access = listOf(part("admin"), "staffAccess", "areas.admin") as Record<string, unknown>[];
  for (const item of access) {
    equal(
      Object.keys(item).sort().join(","),
      "action,at",
      "export: the keys of a staff access item (the date and the action only)",
    );
  }
  if (staffRead) {
    check(
      access.some((item) => item.action === "member.viewed"),
      "export: staff reading the member is not in areas.admin.staffAccess",
      { observed: JSON.stringify(access).slice(0, 300) },
    );
  }
}

/** The export's status while it is not finished yet. */
async function exportStatus(agent: Agent, requestId: string) {
  const list = await succeeds(() => agent.api.listPrivacyRequests(), "GET /privacy/requests");
  const request = list.items.find((item) => item.id === requestId);
  if (request?.status === "failed")
    fail("the export failed", { observed: JSON.stringify(request) });
  return request;
}

/**
 * Wait for an export to complete. Inline (`WEBFLIX_EXPORT_EVENTS=inline`) it finishes within the
 * eventual budget. In batch mode it stays `processing` until the pipeline's `export-events` job
 * records its result: the suite recognises that mode from the operator's list (staff token),
 * checks the entry, and waits for the deployment's job as the job shows itself in the audit log
 * (a round within `--export-wait`; then until its deferral of this request, within
 * `--export-wait-max`). No round at all is a skip naming the two fixes; rounds that never finish
 * the export, or a job that fails it, are failures.
 */
async function awaitExport(
  ctx: CheckContext,
  agent: Agent,
  started: { id: string; requestedAt: string },
  event: ClientEventInput | null,
  terms: PrivacyTerms,
): Promise<PrivacyRequest> {
  let request: PrivacyRequest | undefined;
  if (terms.exportMode === "inline") {
    // The deployment says the export job reads the events itself: ready within its typical time.
    const budget = Math.max(ctx.options.eventualTimeoutMs, 2 * terms.exportTypicalSec * 1000);
    const begun = Date.now();
    while (Date.now() - begun < budget) {
      request = await exportStatus(agent, started.id);
      if (request?.status === "completed" && request.downloadUrl) return request;
      await ctx.sleep(500);
    }
    fail("an inline export did not complete in twice its typical time", {
      expected: `completed within ${Math.round(budget / 1000)} s (terms: inline, typically ${terms.exportTypicalSec} s)`,
      observed: `status ${request?.status ?? "unlisted"}`,
    });
  }
  // Batch (terms.exportMode): the pipeline's export-events job reads the events.
  if (!(await ctx.env.staffIssuer()).available) {
    const begun = Date.now();
    while (Date.now() - begun < ctx.options.exportWaitMs) {
      request = await exportStatus(agent, started.id);
      if (request?.status === "completed" && request.downloadUrl) return request;
      await ctx.sleep(5_000);
    }
    ctx.skip(
      `batch export mode (GET /privacy/requests terms.exportMode, typically ${terms.exportTypicalSec} s): the export is still ${request?.status ?? "unlisted"} after ${Math.round(ctx.options.exportWaitMs / 1000)} s, and without a staff token the suite cannot see the job's rounds. Fix the deployment one of two ways: run the pipeline's export-events job on a schedule shorter than --export-wait, or set WEBFLIX_EXPORT_EVENTS=inline where it is allowed (dev; refused at startup on Kubernetes and Cloudflare)`,
    );
  }
  const admin = ctx
    .agent("export-operator")
    .staffApi(() => ctx.env.staffToken(STAFF_PERSONAS.admin));
  // The request is listed once the deployment's own export job has assembled everything but the
  // events: at once where jobs run in the API process (dev), after a queue delivery elsewhere
  // (Valkey Streams, Cloudflare Queues' batch window). Waited for like any eventual effect, once
  // a second (each read of the operator's list is itself audited).
  type Pending = Awaited<ReturnType<typeof admin.listPendingExports>>["requests"][number];
  type Listed = { completed: PrivacyRequest } | { entry: Pending };
  const listed = await ctx.eventually<Listed>(
    "the batch export is listed for the pipeline's job at GET /api/admin/v1/system/privacy/exports (or completes)",
    async () => {
      const current = await exportStatus(agent, started.id);
      if (current?.status === "completed" && current.downloadUrl) {
        return { done: true, value: { completed: current } };
      }
      const pending = await succeeds(
        () => admin.listPendingExports({ query: { limit: 500 } }),
        "GET /system/privacy/exports",
      );
      const found = pending.requests.find((item) => item.requestId === started.id);
      return found
        ? { done: true, value: { entry: found } }
        : {
            done: false,
            observed: `status ${current?.status ?? "unlisted"}, not among ${pending.requests.length} pending exports`,
          };
    },
    { intervalMs: 1_000 },
  );
  if ("completed" in listed.value) return listed.value.completed;
  const entry = listed.value.entry;
  // Batch mode: the entry the job reads (the account's key, the retention window up to the request).
  equal(entry.to, started.requestedAt, "the pending export's window ends at the request");
  check(
    Date.parse(entry.to) - Date.parse(entry.from) >= 365 * 86_400_000,
    "the pending export's window does not cover the raw retention",
    { observed: `${entry.from} → ${entry.to}` },
  );
  if (event) {
    const stored = await agent.api
      .getRecentEvents({ query: { deviceId: event.deviceId } })
      .then((page) => page.items.find((item) => item.eventId === event.eventId))
      .catch(() => undefined);
    if (stored?.subject.account) {
      equal(entry.accountKey, stored.subject.account, "the pending export's account key");
    }
  }
  // How long to wait is read from the deployment's job itself, as it shows in the audit log:
  // whether a round ran since the request, and when it deferred this request until.
  const firstRoundMs = ctx.options.exportWaitMs;
  const capMs = Math.max(ctx.options.exportWaitMaxMs, firstRoundMs);
  const requestedAt = Date.parse(started.requestedAt);
  ctx.note(
    `batch export (WEBFLIX_EXPORT_EVENTS=batch): waiting up to ${Math.round(firstRoundMs / 1000)} s for a round of the deployment's export-events job, then as its deferral says (at most ${Math.round(capMs / 1000)} s)`,
  );
  let deadline = Date.now() + firstRoundMs;
  let observed: JobRounds = { rounds: [], deferredUntil: null, seen: false };
  for (;;) {
    request = await exportStatus(agent, started.id);
    if (request?.status === "completed" && request.downloadUrl) {
      ctx.note(
        `completed by the deployment's job ${Math.round((Date.now() - requestedAt) / 1000)} s after the request (${observed.rounds.length} job rounds seen)`,
      );
      return request;
    }
    observed = await jobRounds(ctx, admin, started.id, requestedAt);
    if (observed.deferredUntil !== null) {
      const period = roundPeriodMs(observed.rounds, requestedAt);
      const due = observed.deferredUntil + period + 30_000;
      if (due - requestedAt > capMs) {
        ctx.skip(
          `batch export mode: the deployment's export-events job deferred this export until ${new Date(observed.deferredUntil).toISOString()} (its grace), beyond what the suite waits (--export-wait-max ${Math.round(capMs / 1000)} s): raise --export-wait-max, or give the job a shorter grace`,
        );
      }
      deadline = Math.max(deadline, due);
    } else if (observed.rounds.length > 0) {
      deadline = Math.max(
        deadline,
        Date.now() + roundPeriodMs(observed.rounds, requestedAt) + 30_000,
      );
    }
    deadline = Math.min(deadline, requestedAt + capMs);
    if (Date.now() >= deadline) break;
    await ctx.sleep(Math.min(5_000, Math.max(500, (deadline - Date.now()) / 10)));
  }
  if (observed.rounds.length === 0) {
    ctx.skip(
      `batch export mode (WEBFLIX_EXPORT_EVENTS=batch): no export-events job recorded anything in the ${Math.round(firstRoundMs / 1000)} s after the request (no results at POST /system/privacy/exports/results; the export stays ${request?.status ?? "unlisted"}, listed at GET /system/privacy/exports). Fix the deployment one of two ways: run the pipeline's export-events job on a schedule shorter than --export-wait (services/recs/README.md, "Exports of members' events"; locally on Cloudflare make cf-dev CF_JOBS_EVERY=10, or make cf-export-events by hand), or set WEBFLIX_EXPORT_EVENTS=inline where it is allowed (dev; refused at startup on Kubernetes and Cloudflare)`,
    );
  }
  fail("the deployment's export-events job runs but did not finish this export", {
    expected: "completed after the job's round (or its deferral)",
    observed: `status ${request?.status ?? "unlisted"} ${Math.round((Date.now() - requestedAt) / 1000)} s after the request; ${observed.rounds.length} job rounds since, ${observed.seen ? "this request in them" : "this request in none of them"}${observed.deferredUntil ? `, deferred until ${new Date(observed.deferredUntil).toISOString()}` : ""}`,
  });
}

interface JobRounds {
  /** When the deployment's job recorded results since the request (epoch ms, oldest first). */
  rounds: number[];
  /** The latest `notBefore` the job gave this request (a deferral), if any. */
  deferredUntil: number | null;
  /** Whether any round named this request. */
  seen: boolean;
}

/** The deployment's export-events rounds since the request, from the audit log (not the suite's). */
async function jobRounds(
  ctx: CheckContext,
  admin: ReturnType<Agent["staffApi"]>,
  requestId: string,
  since: number,
): Promise<JobRounds> {
  const page = await succeeds(
    () =>
      admin.listAuditLog({ query: { targetType: "event_lake", targetId: "exports", limit: 50 } }),
    "GET /audit (export-events rounds)",
  );
  const own = `smk-${ctx.options.runId}-`;
  const rounds = page.items.filter(
    (entry) =>
      entry.action === "privacy.export_events_recorded" &&
      Date.parse(entry.createdAt) >= since &&
      !(entry.requestId ?? "").startsWith(own),
  );
  let deferredUntil: number | null = null;
  let seen = false;
  for (const entry of rounds) {
    const results =
      ((entry.before as { request?: { results?: unknown[] } } | null)?.request?.results as
        | { requestId?: string; status?: string; notBefore?: string }[]
        | undefined) ?? [];
    for (const result of results) {
      if (result.requestId !== requestId) continue;
      seen = true;
      if (result.status === "deferred" && result.notBefore) {
        deferredUntil = Math.max(deferredUntil ?? 0, Date.parse(result.notBefore));
      }
    }
  }
  return {
    rounds: rounds.map((entry) => Date.parse(entry.createdAt)).sort((a, b) => a - b),
    deferredUntil,
    seen,
  };
}

/** The job's period as observed (the median gap between rounds), else the wait for the first. */
function roundPeriodMs(rounds: number[], since: number): number {
  const gaps = rounds.slice(1).map((at, index) => at - (rounds[index] ?? at));
  if (gaps.length > 0)
    return [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 60_000;
  return rounds[0] !== undefined ? Math.max(5_000, rounds[0] - since) : 60_000;
}

export const privacyChecks: CheckDefinition[] = [
  {
    id: "privacy.events",
    area: "privacy",
    title:
      "Behaviour events are accepted and readable back, stamped by the server (receipt time, pseudonymous subject, plan, consent); a client-supplied identity, a second device or an oversized batch is refused",
    async run(ctx: CheckContext) {
      const account = await member(ctx, "events");
      const agent = account.agent;
      const mode = (await consentOf(agent)).mode;
      if (mode === "off") {
        ctx.skip(
          "the deployment's consent mode is off (WEBFLIX_CONSENT_MODE): nothing is collected; privacy.consent covers that mode",
        );
      }
      await grantAll(agent);
      const titleId = await anyTitle(ctx);
      const stream = new EventStream(deviceId("events"));
      const context = {
        rowId: "home:trending",
        rowRank: 2,
        rank: 3,
        policy: { id: "rules", explore: false },
      };
      const sent = [
        stream.event("impression", { titleId, sampleRate: 1 }, context),
        stream.event("title.open", { titleId }, context),
        stream.event("list.add", { titleId }),
      ];
      const sentAt = Date.now();
      const ack = await succeeds(
        () => agent.api.ingestEvents({ body: { events: sent } }),
        "POST /events",
      );
      equal(ack.accepted, sent.length, "accepted");
      equal(ack.dropped, 0, "dropped");
      const ids = new Set(sent.map((event) => event.eventId));
      const read = await readBackUntil(
        ctx,
        agent,
        { deviceId: stream.deviceId },
        "the batch in the read-back",
        (events) => sent.every((event) => events.some((item) => item.eventId === event.eventId)),
      );
      const accountId = account.session.account.id;
      for (const original of sent) {
        const stored = read.find((item) => item.eventId === original.eventId);
        check(stored, `event ${original.type} is missing from the read-back`);
        const what = `stored ${original.type}`;
        equal(stored.source, "client", `${what}: source`);
        equal(stored.type, original.type, `${what}: type`);
        equal(stored.occurredAt, original.occurredAt, `${what}: occurredAt (the client's clock)`);
        const received = Date.parse(stored.receivedAt);
        check(
          received >= sentAt - 5_000 && received <= Date.now() + 5_000,
          `${what}: receivedAt is not the server's receipt time`,
          {
            observed: `${stored.receivedAt} (sent ${new Date(sentAt).toISOString()})`,
          },
        );
        equal(JSON.stringify(stored.payload), JSON.stringify(original.payload), `${what}: payload`);
        equal(stored.context.rowRank, original.context.rowRank, `${what}: context.rowRank`);
        equal(stored.context.rank, original.context.rank, `${what}: context.rank`);
        equal(stored.deviceId, stream.deviceId, `${what}: deviceId`);
        const subject = stored.subject;
        check(
          subject.account !== null &&
            SUBJECT_KEY.test(subject.account) &&
            !accountId.replaceAll("-", "").includes(subject.account.slice(0, 12)) &&
            subject.account !== subject.profile,
          `${what}: subject.account is not a pseudonymous key`,
          { observed: String(subject.account) },
        );
        check(
          subject.profile !== null && SUBJECT_KEY.test(subject.profile),
          `${what}: subject.profile is not a pseudonymous key`,
          {
            observed: String(subject.profile),
          },
        );
        equal(subject.plan, "standard", `${what}: subject.plan`);
        equal(subject.restricted, false, `${what}: subject.restricted`);
        equal(
          JSON.stringify(subject.consent),
          JSON.stringify({ analytics: true, personalisation: true }),
          `${what}: subject.consent`,
        );
      }
      check(ids.size === sent.length, "duplicate event ids sent");

      const raw = (body: unknown) =>
        agent.fetch(`${API}/events`, { method: "POST", headers: CSRF, body: body as object });
      const forged = {
        ...stream.event("title.open", { titleId }),
        subject: { account: "x".repeat(22) },
      };
      problem(await raw({ events: [forged] }), "validation_failed", "an event carrying a subject");
      const elsewhere = new EventStream(deviceId("events-b"));
      problem(
        await raw({
          events: [
            stream.event("title.open", { titleId }),
            elsewhere.event("title.open", { titleId }),
          ],
        }),
        "validation_failed",
        "a batch from two devices",
      );
      problem(
        await raw({
          events: Array.from({ length: 51 }, () => stream.event("title.open", { titleId })),
        }),
        "validation_failed",
        "a batch of 51 events",
      );
      // 64 KiB at most, refused before it is parsed.
      const experiments = Object.fromEntries(
        Array.from({ length: 14 }, (_, index) => [
          `smoke.padding-${index}-${"x".repeat(40)}`,
          "v".repeat(64),
        ]),
      );
      problem(
        await raw({
          events: Array.from({ length: 50 }, () =>
            stream.event("title.open", { titleId }, { experiments }),
          ),
        }),
        "payload_too_large",
        "a batch over 64 KiB",
      );

      // Signed out: a device's own banner answer is what applies (opt-in).
      const visitor = ctx.agent("events-visitor");
      const anonymous = new EventStream(deviceId("visitor"));
      const withConsent = await succeeds(
        () =>
          visitor.api.ingestEvents({
            body: {
              events: [anonymous.event("title.open", { titleId }, { surface: "landing" })],
              consent: { analytics: true, personalisation: true },
            },
          }),
        "POST /events signed out, with the device's consent",
      );
      equal(withConsent.accepted, 1, "a signed-out event with consent");
      if (mode === "opt-in") {
        const without = await succeeds(
          () =>
            visitor.api.ingestEvents({
              body: {
                events: [anonymous.event("title.open", { titleId }, { surface: "landing" })],
              },
            }),
          "POST /events signed out, no consent",
        );
        equal(without.dropped, 1, "a signed-out event without consent (opt-in)");
      }
      // The read-back is the account's own.
      const other = await ctx.env.bareSignup("events-other");
      const foreign = await readBack(ctx, other.agent, { deviceId: stream.deviceId });
      check(!foreign.some((event) => ids.has(event.eventId)), "another account reads these events");
    },
  },
  {
    id: "privacy.kids-profile",
    area: "privacy",
    title:
      "A kids profile produces no behavioural events, by any path (client events dropped, playback emits nothing), while the adult profile of the same account does",
    async run(ctx: CheckContext) {
      const account = await member(ctx, "kids-events");
      const mode = (await consentOf(account.agent)).mode;
      if (mode === "off")
        ctx.skip("consent mode off: no profile produces events, so absence proves nothing");
      await grantAll(account.agent);
      const kids = await ctx.env.createProfile(account.agent, { name: "Kid", isKids: true });
      const kidsDevice = await ctx.env.login(account, "kids-device");
      await ctx.env.selectProfile(kidsDevice, kids.id);
      const titleId = await anyTitle(ctx, true);

      const kidsStream = new EventStream(deviceId("kids"));
      const dropped = await succeeds(
        () =>
          kidsDevice.api.ingestEvents({
            body: {
              events: [
                kidsStream.event("impression", { titleId, sampleRate: 1 }),
                kidsStream.event("title.open", { titleId }),
                kidsStream.event("list.add", { titleId }),
              ],
            },
          }),
        "POST /events from the kids profile",
      );
      equal(dropped.accepted, 0, "client events accepted from a kids profile");
      equal(dropped.dropped, 3, "client events dropped from a kids profile");
      const kidsPlay = await succeeds(
        () => kidsDevice.api.createPlaybackSession({ body: { titleId } }),
        "kids playback",
      );
      await succeeds(
        () =>
          kidsDevice.api.sendHeartbeat({
            params: { id: kidsPlay.id },
            body: { positionSec: 5, durationSec: kidsPlay.durationSec, state: "playing" },
          }),
        "kids heartbeat",
      );
      await succeeds(
        () => kidsDevice.api.endPlaybackSession({ params: { id: kidsPlay.id } }),
        "kids stop",
      );

      // The adult profile doing the same is collected: the absence above is meaningful.
      const adultStream = new EventStream(deviceId("adult"));
      const accepted = await succeeds(
        () =>
          account.agent.api.ingestEvents({
            body: { events: [adultStream.event("title.open", { titleId })] },
          }),
        "POST /events from the adult profile",
      );
      equal(accepted.accepted, 1, "client events accepted from the adult profile");
      const adultPlay = await succeeds(
        () => account.agent.api.createPlaybackSession({ body: { titleId } }),
        "adult playback",
      );
      await succeeds(
        () => account.agent.api.endPlaybackSession({ params: { id: adultPlay.id } }),
        "adult stop",
      );
      const session = await succeeds(() => account.agent.api.getSession(), "GET /session (adult)");
      const adultProfileId = session.authenticated ? session.activeProfile?.id : undefined;
      check(adultProfileId, "the adult device has no active profile");
      await readBackUntil(
        ctx,
        account.agent,
        { profileId: adultProfileId },
        "the adult's playback.start",
        (events) =>
          events.some(
            (event) =>
              event.type === "playback.start" && event.payload.playbackSessionId === adultPlay.id,
          ),
      );
      const fromKids = await readBack(ctx, account.agent, { profileId: kids.id });
      check(fromKids.length === 0, "the kids profile produced behavioural events", {
        expected: "none (§6.3: only server events needed to operate, never kept as behaviour)",
        observed: fromKids.map((event) => `${event.type} (${event.source})`).join(", "),
      });
      const all = await readBack(ctx, account.agent, { limit: 500 });
      const restricted = all.filter((event) => event.subject.restricted);
      check(restricted.length === 0, "events of a restricted profile were kept", {
        observed: restricted.map((event) => event.type).join(", "),
      });
      check(
        !all.some((event) => event.deviceId === kidsStream.deviceId),
        "the kids device's events were kept",
      );
    },
  },
  {
    id: "privacy.consent",
    area: "privacy",
    title:
      "Consent behaves as the deployment's mode says (opt-in withholds until granted, opt-out collects until withdrawn and honours Global Privacy Control, off collects nothing); every answer emits consent.change",
    async run(ctx: CheckContext) {
      const visitor = ctx.agent("consent-visitor");
      const open = await consentOf(visitor);
      const gpc = await consentOf(visitor, { "Sec-GPC": "1" });
      equal(gpc.gpc, true, "gpc with Sec-GPC: 1");
      equal(open.gpc, false, "gpc without the header");
      const mode = open.mode;
      ctx.note(
        `consent mode: ${mode} (the other modes need a deployment configured so: WEBFLIX_CONSENT_MODE)`,
      );
      const account = await ctx.env.bareHolder("consent");
      const agent = account.agent;
      const titleId = await anyTitle(ctx);
      const stream = new EventStream(deviceId("consent"));
      const send = async (what: string) =>
        succeeds(
          () =>
            agent.api.ingestEvents({ body: { events: [stream.event("title.open", { titleId })] } }),
          `POST /events (${what})`,
        );
      const answer = (purpose: "analytics" | "personalisation", granted: boolean) =>
        succeeds(
          () => agent.api.updateConsent({ body: { purpose, granted, source: "settings" } }),
          `PUT /privacy/consent (${purpose} ${granted})`,
        );
      const initial = await consentOf(agent);
      if (mode === "opt-in") {
        equal(initial.promptRequired, true, "promptRequired before any answer (opt-in)");
        equal(initial.purposes.analytics.granted, false, "analytics before any answer (opt-in)");
        equal(initial.purposes.analytics.source, null, "source of the default");
        equal((await send("before consent")).dropped, 1, "an event before consent (opt-in)");
        await answer("analytics", true);
        const granted = await answer("personalisation", true);
        equal(granted.promptRequired, false, "promptRequired after answering");
        equal((await send("after granting")).accepted, 1, "an event after granting");
        await answer("analytics", false);
        const withdrawn = await answer("personalisation", false);
        equal(
          withdrawn.purposes.personalisation.granted,
          false,
          "personalisation after withdrawing",
        );
        equal(
          (await send("after withdrawing")).dropped,
          1,
          "an event after withdrawing everything",
        );
        const changes = await readBackUntil(
          ctx,
          agent,
          { limit: 100 },
          "four consent.change events",
          (events) => events.filter((event) => event.type === "consent.change").length >= 4,
        );
        const latest = changes.find((event) => event.type === "consent.change");
        check(
          latest?.type === "consent.change" && latest.payload.granted === false,
          "the latest consent.change is not the withdrawal",
          {
            observed: JSON.stringify(latest?.payload ?? null),
          },
        );
      } else if (mode === "opt-out") {
        equal(initial.promptRequired, false, "promptRequired (opt-out)");
        equal(initial.purposes.analytics.granted, true, "analytics by default (opt-out)");
        equal((await send("by default")).accepted, 1, "an event by default (opt-out)");
        // Global Privacy Control withdraws what the member never answered explicitly.
        const withGpc = await consentOf(agent, { "Sec-GPC": "1" });
        equal(withGpc.purposes.analytics.granted, false, "analytics under Global Privacy Control");
        equal(withGpc.purposes.analytics.source, "gpc", "source of the GPC withdrawal");
        equal((await send("after GPC")).dropped, 1, "an event after the GPC withdrawal");
        await answer("analytics", true);
        await answer("personalisation", true);
        equal(
          (await consentOf(agent, { "Sec-GPC": "1" })).purposes.analytics.granted,
          true,
          "an explicit grant wins over GPC",
        );
        equal(
          (await send("after the explicit grant")).accepted,
          1,
          "an event after the explicit grant",
        );
      } else {
        equal(initial.promptRequired, false, "promptRequired (off)");
        equal((await send("off")).dropped, 1, "an event in off mode");
        const tried = await agent.fetch(`${API}/privacy/consent`, {
          method: "PUT",
          headers: CSRF,
          body: { purpose: "analytics", granted: true, source: "settings" },
        });
        check(tried.status < 500, "PUT /privacy/consent failed in off mode", {
          exchange: tried.exchange,
        });
        equal((await send("off, after a grant")).dropped, 1, "an event in off mode after a grant");
      }
      // A kids profile cannot answer for the account.
      const kids = await ctx.env.createProfile(agent, { name: "Kid", isKids: true });
      const kidsDevice = await ctx.env.login(account, "consent-kids");
      await ctx.env.selectProfile(kidsDevice, kids.id);
      await rejects(
        () =>
          kidsDevice.api.updateConsent({
            body: { purpose: "analytics", granted: true, source: "settings" },
          }),
        "unrestricted_profile_required",
        "PUT /privacy/consent from a kids profile",
      );
    },
  },
  {
    id: "privacy.export",
    area: "privacy",
    title:
      "Download your data: needs a fresh proof, one at a time, completes (inline, or in batch mode once the deployment's export-events job ran) with a signed link (emailed) to a document holding the account, its profiles and events; only its account may open it",
    // Batch mode waits for the deployment's job (--export-wait, --export-wait-max).
    timeoutMs: 1_800_000,
    async run(ctx: CheckContext) {
      const account = await member(ctx, "export");
      const agent = account.agent;
      const mode = (await consentOf(agent)).mode;
      const titleId = await anyTitle(ctx);
      const stream = new EventStream(deviceId("export"));
      const event = stream.event("title.open", { titleId });
      let collected = false;
      if (mode !== "off") {
        await grantAll(agent);
        collected =
          (
            await succeeds(
              () => agent.api.ingestEvents({ body: { events: [event] } }),
              "POST /events",
            )
          ).accepted === 1;
      }
      // Staff reading the member is part of what the export reports (`areas.admin.staffAccess`).
      const staffRead = (await ctx.env.staffIssuer()).available
        ? await audited(
            async () =>
              (await staffClient(ctx, "support")).getMember({
                params: { accountId: account.session.account.id },
              }),
            "GET /members/:id (support reads the member before the export)",
          )
        : null;
      await rejects(
        () => agent.api.requestDataExport(),
        "reauthentication_required",
        "an export without a fresh proof",
      );
      await succeeds(
        () => agent.api.elevate({ body: { password: account.password } }),
        "POST /session/elevation",
      );
      // Two at once: exactly one starts (one export at a time, decided atomically).
      const raced = await Promise.all(
        [1, 2].map(() => agent.fetch(`${API}/privacy/export`, { method: "POST", headers: CSRF })),
      );
      const started = raced.filter((result) => result.status === 202);
      equal(started.length, 1, "exports started by two concurrent requests");
      const refused = raced.find((result) => result.status !== 202);
      check(refused, "both concurrent exports answered 202");
      problem(refused, "privacy_request_pending", "the second concurrent export");
      const startedRequest = started[0]?.json<PrivacyRequest>();
      check(startedRequest, "the started export has no body");
      check(
        startedRequest.email === "pending" || startedRequest.email === "sent",
        "a new export's email is not pending",
        { expected: 'email "pending" (sent when ready)', observed: String(startedRequest.email) },
      );
      const terms = (await succeeds(() => agent.api.listPrivacyRequests(), "GET /privacy/requests"))
        .terms;
      const done = await awaitExport(ctx, agent, startedRequest, collected ? event : null, terms);
      // The "your data is ready" email went out (suite addresses never bounced).
      await ctx.eventually("the completed export's email is sent", async () => {
        const email = (await exportStatus(agent, startedRequest.id))?.email;
        return email === "sent"
          ? { done: true, value: email }
          : { done: false, observed: `email ${String(email)}` };
      });
      if (done.completedAt && done.expiresAt) {
        const ttl = (Date.parse(done.expiresAt) - Date.parse(done.completedAt)) / 1000;
        check(
          Math.abs(ttl - terms.exportLinkTtlSec) <= 60,
          "the export link's lifetime is not the one the terms state",
          {
            expected: `${terms.exportLinkTtlSec} s (terms.exportLinkTtlSec)`,
            observed: `${Math.round(ttl)} s (${done.completedAt} → ${done.expiresAt})`,
          },
        );
      }
      const link = agent.ownPath(done.downloadUrl ?? "");
      check(link, "the export link points to another origin", {
        observed: String(done.downloadUrl),
      });
      check(
        done.expiresAt && Date.parse(done.expiresAt) > Date.now(),
        "the export link has no future expiry",
      );
      const token = new URL(link, agent.origin).searchParams.get("token");
      check(token, "the export link carries no token", { observed: link });
      const downloadPath = `${API}/privacy/exports/${encodeURIComponent(startedRequest.id)}/download`;
      const fetchExport = (device: Agent, body: { token: string }) =>
        device.fetch(downloadPath, { method: "POST", headers: CSRF, body });
      const attachment = (result: Awaited<ReturnType<Agent["fetch"]>>, what: string) =>
        check(
          /attachment/i.test(result.headers.get("Content-Disposition") ?? ""),
          `${what}: the export is not served as an attachment`,
          {
            observed: result.headers.get("Content-Disposition") ?? "(absent)",
            exchange: result.exchange,
          },
        );
      // The link form still works for the holder with a fresh proof (links already handed out).
      const viaLink = await agent.fetch(link);
      status(viaLink, 200, "GET the export link (fresh proof)");
      attachment(viaLink, "GET the export link");
      // Another device of the account, the holder's profile chosen, no fresh proof: refused in
      // either form (the token is checked first: a bad one is not_found even without a proof).
      const device = await ctx.env.login(account, "export-device");
      await ctx.env.holder(account, device);
      problem(
        await device.fetch(link),
        "reauthentication_required",
        "GET the export link without a fresh proof",
      );
      problem(
        await fetchExport(device, { token: `${token.slice(0, -2)}AA` }),
        "not_found",
        "POST /privacy/exports/:id/download with a bad token (no fresh proof)",
      );
      problem(
        await fetchExport(device, { token }),
        "reauthentication_required",
        "POST /privacy/exports/:id/download without a fresh proof",
      );
      await succeeds(
        () => device.api.elevate({ body: { password: account.password } }),
        "POST /session/elevation (the other device)",
      );
      const download = await fetchExport(device, { token });
      status(download, 200, "POST /privacy/exports/:id/download (the token in the body)");
      attachment(download, "POST /privacy/exports/:id/download");
      const parsed = DataExport.safeParse(download.json());
      if (!parsed.success) {
        fail("the export document does not match the contract", {
          details: parsed.error.issues
            .slice(0, 10)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          exchange: download.exchange,
        });
      }
      const document = parsed.data;
      equal(document.account.email, account.email, "export: account email");
      equal(document.requestId, startedRequest.id, "export: requestId");
      check(
        document.profiles.some((profile) => profile.name === "Holder"),
        "export: the profile is missing",
      );
      assertExportAreas(document.areas, staffRead !== null);
      if (collected) {
        check(
          document.events.some((item) => item.eventId === event.eventId),
          "export: the account's event is missing",
          {
            observed: `${document.events.length} events`,
          },
        );
      }
      if (mode !== "off")
        check(document.consents.length >= 2, "export: the consent answers are missing");
      // Only its account, signed in as the holder, may open it.
      const other = await ctx.env.bareHolder("export-other");
      problem(
        await other.agent.fetch(link),
        "not_found",
        "another account opening the export link",
      );
      problem(
        await ctx.agent("export-anonymous").fetch(link),
        "unauthenticated",
        "the export link signed out",
      );
      const tampered = link.replace(
        /token=([^&]*)/,
        (_whole, token: string) => `token=${token.slice(0, -2)}AA`,
      );
      problem(await agent.fetch(tampered), "not_found", "a tampered export link");
      if ((await ctx.env.mailbox()).available) {
        // The email opens the web app's page, the token in the fragment (never sent with the
        // page load); the page downloads through the API route with it.
        const [mail] = await awaitMail(ctx, agent, account.email, "data-export-ready");
        check(mail, "no data-export-ready email");
        const page = `/account/privacy/exports/${encodeURIComponent(startedRequest.id)}`;
        const emailed = mail.links
          .map((candidate) => {
            try {
              return new URL(candidate);
            } catch {
              return null;
            }
          })
          .find((url) => url !== null && url.pathname === page);
        check(emailed, "the export email does not link to the web app's export page", {
          expected: `{origin}${page}#token=…`,
          observed: mail.links.join(", "),
        });
        check(agent.sameDeployment(emailed.href), "the export email links to another origin", {
          observed: emailed.href,
        });
        equal(
          emailed.search,
          "",
          "the export page link's query (the token belongs in the fragment)",
        );
        const emailedToken = new URLSearchParams(emailed.hash.slice(1)).get("token");
        check(emailedToken, "the export page link has no #token=", { observed: emailed.href });
        // The page sends the fragment's token in the body (never in a URL).
        const viaEmail = await fetchExport(device, { token: emailedToken });
        status(viaEmail, 200, "the export downloaded with the emailed token");
        equal(
          viaEmail.json<{ requestId?: unknown }>().requestId,
          startedRequest.id,
          "the document behind the emailed link",
        );
      }
    },
  },
  {
    id: "privacy.export-operator",
    area: "privacy",
    title:
      "The operator's side of data exports (admin only): a results document for an unknown request changes nothing, one pointing at a file that is not the request's own or a complete result without its checksum is refused; in batch mode a deferred or failed result keeps the export listed for the job's next round (still one export at a time)",
    needs: [needs.staffIssuer],
    async run(ctx: CheckContext) {
      const admin = ctx
        .agent("exports-admin")
        .staffApi(() => ctx.env.staffToken(STAFF_PERSONAS.admin));
      const route = `${ADMIN_API_BASE_PATH}/system/privacy/exports`;
      for (const role of ["support", "billing", "content", "experiments"] as const) {
        const api = ctx
          .agent(`exports-${role}`)
          .staffApi(() => ctx.env.staffToken(STAFF_PERSONAS[role]));
        const refused = await rejects(
          () => api.listPendingExports({ query: {} }),
          "staff_role_required",
          `GET /system/privacy/exports as ${role}`,
        );
        equal(refused.problem.requiredRole, "admin", "requiredRole");
        await rejects(
          () => api.recordExportResults({ body: resultsDocument([], "smoke: refused") }),
          "staff_role_required",
          `POST /system/privacy/exports/results as ${role}`,
        );
      }
      const member = await ctx.env.bareSignup("exports-member");
      problem(
        await member.agent.fetch(route),
        "unauthenticated",
        "a member's session on the operator's route",
      );

      // A result for a request the product does not know is recorded as ignored, changing nothing.
      const unknownId = `smoke-${ctx.options.runId}-${unique("unknown")}`;
      const now = new Date().toISOString();
      const before = await succeeds(
        () => admin.listPendingExports({ query: { limit: 500 } }),
        "GET /system/privacy/exports",
      );
      check(
        !before.requests.some((item) => item.requestId === unknownId),
        "an unknown request is listed",
      );
      const recorded = await audited(
        () =>
          admin.recordExportResults({
            body: resultsDocument(
              [{ requestId: unknownId, status: "erased", from: now, to: now }],
              "smoke: unknown request",
            ),
          }),
        "POST /system/privacy/exports/results (an unknown request)",
      );
      const after = await succeeds(
        () => admin.listPendingExports({ query: { limit: 500 } }),
        "GET /system/privacy/exports",
      );
      check(
        !after.requests.some((item) => item.requestId === unknownId),
        "a result for an unknown request created an export",
      );
      const entries = await auditOf(admin, { targetId: "exports", targetType: "event_lake" });
      const entry = entries.find((candidate) => candidate.requestId === recorded.requestId);
      check(entry, "the results document has no audit entry", {
        expected: `requestId ${recorded.requestId}`,
      });
      equal(entry.outcome, "succeeded", "audit outcome");
      check(
        JSON.stringify(entry.after).includes(unknownId) &&
          JSON.stringify(entry.after).includes("ignored"),
        "the audit entry does not record the unknown request as ignored",
        {
          observed: JSON.stringify(entry.after),
        },
      );

      // The job can only point at the request's own documents, and a complete result is verifiable.
      const subject = before.requests[0]?.requestId ?? unknownId;
      const post = async (body: unknown) =>
        ctx.agent("exports-raw").fetch(`${route}/results`, {
          method: "POST",
          headers: {
            ...CSRF,
            Authorization: `Bearer ${await ctx.env.staffToken(STAFF_PERSONAS.admin)}`,
          },
          body: body as object,
        });
      const own = `privacy/export-events/${subject}`;
      const complete = (extra: Record<string, unknown>) =>
        resultsDocument(
          [
            {
              requestId: subject,
              status: "complete",
              from: now,
              to: now,
              events: 1,
              manifest: `${own}/manifest.json`,
              bytes: 10,
              sha256: "0".repeat(64),
              file: `${own}/events.ndjson.gz`,
              ...extra,
            },
          ],
          "smoke: forged result",
        );
      for (const [what, document] of [
        [
          "another request's events file",
          complete({ file: `privacy/export-events/${unknownId}-other/events.ndjson.gz` }),
        ],
        [
          "the member's export document itself",
          complete({ file: `privacy/exports/${subject}.json.gz` }),
        ],
        [
          "a file outside the job's prefix",
          complete({ file: "events/dt=2026-11-22/hh=00/x.ndjson.gz" }),
        ],
        ["a complete result without its checksum", complete({ sha256: undefined })],
      ] as const) {
        const refused = problem(
          await post(document),
          "validation_failed",
          `a results document naming ${what}`,
        );
        check(
          (refused as { issues?: unknown[] }).issues?.length,
          `${what}: no validation issue named`,
        );
      }

      // Batch mode: the member's own export, deferred by the job, stays listed.
      const account = await ctx.env.bareHolder("exports-batch");
      await succeeds(
        () => account.agent.api.elevate({ body: { password: account.password } }),
        "POST /session/elevation",
      );
      const requested = await succeeds(
        () => account.agent.api.requestDataExport(),
        "POST /privacy/export",
      );
      const listed = await ctx.eventually(
        "the export completes (inline) or is listed for the job (batch)",
        async () => {
          const status_ = (await exportStatus(account.agent, requested.id))?.status;
          if (status_ === "completed") return { done: true, value: "inline" as const };
          const pending = await succeeds(
            () => admin.listPendingExports({ query: { limit: 500 } }),
            "GET /system/privacy/exports",
          );
          return pending.requests.some((item) => item.requestId === requested.id)
            ? { done: true, value: "batch" as const }
            : { done: false, observed: String(status_) };
        },
      );
      if (listed.value === "inline") {
        ctx.note(
          "inline exports (WEBFLIX_EXPORT_EVENTS=inline): nothing waits for the job, the deferred case does not apply",
        );
        return;
      }
      await succeeds(
        () =>
          admin.recordExportResults({
            body: resultsDocument(
              [
                {
                  requestId: requested.id,
                  status: "deferred",
                  from: now,
                  to: now,
                  notBefore: new Date(Date.now() + 60_000).toISOString(),
                },
              ],
              "smoke: deferred",
            ),
          }),
        "POST /system/privacy/exports/results (deferred)",
      );
      const still = await succeeds(
        () => admin.listPendingExports({ query: { limit: 500 } }),
        "GET /system/privacy/exports",
      );
      check(
        still.requests.some((item) => item.requestId === requested.id),
        "a deferred export is no longer listed for the job",
      );
      equal(
        (await exportStatus(account.agent, requested.id))?.status,
        "processing",
        "a deferred export's status",
      );
      // The job reports it failed: the request stays listed for the job's next round (docs/
      // BACKEND.md: `deferred` and `failed` keep the request listed; every export still open a
      // day after it was asked for is given up, then the member can ask again: privacy review M1).
      await succeeds(
        () =>
          admin.recordExportResults({
            body: resultsDocument(
              [
                {
                  requestId: requested.id,
                  status: "failed",
                  from: now,
                  to: now,
                  error: "smoke: the job could not read the events",
                },
              ],
              "smoke: failed",
            ),
          }),
        "POST /system/privacy/exports/results (failed)",
      );
      const failedState = (
        await succeeds(() => account.agent.api.listPrivacyRequests(), "GET /privacy/requests")
      ).items.find((item) => item.id === requested.id);
      equal(
        failedState?.status,
        "processing",
        "the export after one failed round (retried by the job's next round)",
      );
      check(
        (
          await succeeds(
            () => admin.listPendingExports({ query: { limit: 500 } }),
            "GET /system/privacy/exports",
          )
        ).requests.some((item) => item.requestId === requested.id),
        "an export the job failed once is no longer listed for its next round",
      );
      problem(
        await account.agent.fetch(`${API}/privacy/export`, { method: "POST", headers: CSRF }),
        "privacy_request_pending",
        "a new export while the failed one is still retried (one at a time)",
      );
      ctx.note(
        "batch exports (WEBFLIX_EXPORT_EVENTS=batch): a failed round keeps the export listed and processing; the give-up a day after the request is not observable within a run",
      );
    },
  },
  {
    id: "privacy.terms",
    area: "privacy",
    title:
      "The privacy terms are served before anything is asked: cooling-off, export link lifetime, export mode and typical time, retention periods, the same for every account",
    async run(ctx: CheckContext) {
      const first = await ctx.env.bareHolder("terms");
      const list = await succeeds(
        () => first.agent.api.listPrivacyRequests(),
        "GET /privacy/requests",
      );
      equal(list.items.length, 0, "requests of a new account");
      const terms = list.terms;
      for (const [name, value] of Object.entries({
        deletionCoolingOffSec: terms.deletionCoolingOffSec,
        exportLinkTtlSec: terms.exportLinkTtlSec,
        exportTypicalSec: terms.exportTypicalSec,
        eventsRetentionDays: terms.eventsRetentionDays,
        aggregatesRetentionDays: terms.aggregatesRetentionDays,
      })) {
        check(
          Number.isInteger(value) && value > 0,
          `terms.${name} is not a positive whole number`,
          {
            observed: String(value),
          },
        );
      }
      check(
        ["inline", "batch"].includes(terms.exportMode),
        "terms.exportMode is neither inline nor batch",
        {
          observed: terms.exportMode,
        },
      );
      check(
        terms.aggregatesRetentionDays >= terms.eventsRetentionDays,
        "aggregates are kept for less time than the raw events they summarise",
        { observed: JSON.stringify(terms) },
      );
      const second = await ctx.env.bareHolder("terms-other");
      const other = (
        await succeeds(() => second.agent.api.listPrivacyRequests(), "GET /privacy/requests")
      ).terms;
      equal(JSON.stringify(other), JSON.stringify(terms), "the terms another account is shown");
      problem(
        await ctx.agent("terms-anonymous").fetch(`${API}/privacy/requests`),
        "unauthenticated",
        "GET /privacy/requests signed out",
      );
      ctx.note(
        `cooling-off ${terms.deletionCoolingOffSec} s, export ${terms.exportMode} (typically ${terms.exportTypicalSec} s), link ${terms.exportLinkTtlSec} s, events ${terms.eventsRetentionDays} days, aggregates ${terms.aggregatesRetentionDays} days`,
      );
    },
  },
  {
    id: "privacy.deletion.membership",
    area: "privacy",
    title:
      "A scheduled deletion stops the renewals: the membership ends (no renewal charged when its period closes inside the cooling-off); keeping the account leaves it ending and resumable, and resuming renews again",
    needs: [needs.fakePayments],
    timeoutMs: 180_000,
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const first = await env.bareHolder("deletion-renewals");
      const terms = (
        await succeeds(() => first.agent.api.listPrivacyRequests(), "GET /privacy/requests")
      ).terms;
      if (terms.deletionCoolingOffSec < 8) {
        ctx.skip(
          `the cooling-off period (${terms.deletionCoolingOffSec} s) is too short to act inside it`,
        );
      }
      // A paying member schedules the deletion; the period's close then passes on the clock.
      const card = await spentCard(ctx);
      await paidMembership(ctx, first.agent, { planId: "standard", card });
      const before = await succeeds(() => first.agent.api.getAccount(), "GET /account");
      check(before.membership?.nextInvoice, "a paying member has no next invoice", {
        observed: JSON.stringify(before.membership),
      });
      const periodEnd = before.membership?.currentPeriodEnd;
      check(periodEnd, "no period end");
      await succeeds(
        () => first.agent.api.elevate({ body: { password: first.password } }),
        "POST /session/elevation",
      );
      const scheduled = await succeeds(
        () => first.agent.api.requestAccountDeletion(),
        "POST /account/deletion",
      );
      check(scheduled.scheduledFor, "a deletion without scheduledFor");
      const stopped = await ctx.eventually("the deletion stops the renewals", async () => {
        const list = await succeeds(
          () => first.agent.api.listPrivacyRequests(),
          "GET /privacy/requests",
        );
        const membership = list.items.find((item) => item.id === scheduled.id)?.membership;
        return membership?.status === "ending"
          ? { done: true, value: membership }
          : { done: false, observed: JSON.stringify(membership ?? null) };
      });
      const expectedEnd = Math.min(Date.parse(periodEnd), Date.parse(scheduled.scheduledFor));
      equal(
        stopped.value.endsAt ? Date.parse(stopped.value.endsAt) : null,
        expectedEnd,
        "endsAt (the earlier of the period's close and the erasure)",
      );
      equal(stopped.value.resumable, false, "resumable while the deletion is scheduled");
      const ending = await succeeds(() => first.agent.api.getAccount(), "GET /account");
      equal(ending.membership?.cancelAtPeriodEnd, true, "the membership is set to end");
      equal(ending.membership?.nextInvoice ?? null, null, "no next invoice once renewals stopped");
      const paidBefore = (
        await succeeds(() => first.agent.api.listInvoices({ query: {} }), "invoices")
      ).items.filter((invoice) => invoice.amountPaid.amountMinor > 0).length;
      await advancePast(first.agent, periodEnd, RENEWAL_SETTLE_SEC, "past the period's close");
      const afterClose = await succeeds(
        () => first.agent.api.getAccount(),
        "GET /account after the close",
      );
      equal(afterClose.membership?.status, "canceled", "the membership after its period closed");
      const paidAfter = (
        await succeeds(() => first.agent.api.listInvoices({ query: {} }), "invoices")
      ).items.filter((invoice) => invoice.amountPaid.amountMinor > 0).length;
      equal(paidAfter, paidBefore, "renewals charged after a deletion was scheduled");
      check(
        Date.now() < Date.parse(scheduled.scheduledFor),
        "the cooling-off ran out before the check could keep the account",
        {
          observed: `now ${new Date().toISOString()}, erasure at ${scheduled.scheduledFor}`,
        },
      );
      await succeeds(() => first.agent.api.cancelAccountDeletion(), "keep the account");

      // Another paying member keeps the account at once: still ending, resumable, then resumed.
      const second = await env.bareHolder("deletion-resume");
      await paidMembership(ctx, second.agent, { planId: "standard", card });
      const plan = await succeeds(() => second.agent.api.getAccount(), "GET /account");
      await succeeds(
        () => second.agent.api.elevate({ body: { password: second.password } }),
        "POST /session/elevation",
      );
      const request = await succeeds(
        () => second.agent.api.requestAccountDeletion(),
        "POST /account/deletion",
      );
      await ctx.eventually("the deletion stops the renewals", async () => {
        const list = await succeeds(
          () => second.agent.api.listPrivacyRequests(),
          "GET /privacy/requests",
        );
        const status_ = list.items.find((item) => item.id === request.id)?.membership?.status;
        return status_ === "ending"
          ? { done: true, value: null }
          : { done: false, observed: String(status_) };
      });
      await succeeds(
        () => second.agent.api.cancelAccountDeletion(),
        "DELETE /account/deletion (keep)",
      );
      const kept = (
        await succeeds(() => second.agent.api.listPrivacyRequests(), "GET /privacy/requests")
      ).items.find((item) => item.id === request.id);
      equal(kept?.status, "canceled", "the deletion after keeping the account");
      equal(kept?.membership?.status, "ending", "the membership after keeping the account");
      equal(kept?.membership?.resumable, true, "resumable after keeping the account");
      equal(
        kept?.membership?.endsAt ? Date.parse(kept.membership.endsAt) : null,
        plan.membership?.currentPeriodEnd ? Date.parse(plan.membership.currentPeriodEnd) : null,
        "endsAt once kept (the period's close)",
      );
      equal(
        (await succeeds(() => second.agent.api.getAccount(), "GET /account")).membership
          ?.cancelAtPeriodEnd,
        true,
        "still set to end",
      );
      await succeeds(
        () => second.agent.api.resumeMembership(),
        "POST /account/subscription/resume",
      );
      const resumed = await succeeds(
        () => second.agent.api.getAccount(),
        "GET /account after resuming",
      );
      equal(resumed.membership?.cancelAtPeriodEnd, false, "renewing again after resuming");
      check(resumed.membership?.nextInvoice, "no next invoice after resuming", {
        observed: JSON.stringify(resumed.membership),
      });
      const after = (
        await succeeds(() => second.agent.api.listPrivacyRequests(), "GET /privacy/requests")
      ).items.find((item) => item.id === request.id);
      equal(
        after?.membership?.status,
        "renewing",
        "the deletion's membership effect after resuming",
      );
      equal(after?.membership?.resumable, false, "resumable after resuming");
    },
  },
  {
    id: "privacy.deletion.blocks-billing",
    area: "privacy",
    title:
      "While a deletion is scheduled the member cannot renew the membership again: resume, a plan change, a new checkout and confirming one started before are refused (409 account_deletion_scheduled), a preview and a card change stay allowed, and keeping the account lifts the rule at once",
    needs: [needs.fakePayments],
    timeoutMs: 180_000,
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const card = await spentCard(ctx);
      const post = (agent: Agent, path: string, body?: object) =>
        agent.fetch(`${API}${path}`, {
          method: "POST",
          headers: CSRF,
          ...(body === undefined ? {} : { body }),
        });

      // A paying member.
      const paying = await env.bareHolder("deletion-blocks");
      await paidMembership(ctx, paying.agent, { planId: "standard", card });
      await succeeds(
        () => paying.agent.api.elevate({ body: { password: paying.password } }),
        "POST /session/elevation",
      );
      const request = await succeeds(
        () => paying.agent.api.requestAccountDeletion(),
        "POST /account/deletion",
      );
      try {
        problem(
          await post(paying.agent, "/account/subscription/resume"),
          "account_deletion_scheduled",
          "resuming the membership",
        );
        const preview = await post(paying.agent, "/billing/subscription/preview", {
          planId: "premium",
        });
        status(preview, 200, "previewing a plan change (allowed)");
        const token = preview.json<{ previewToken: string }>().previewToken;
        problem(
          await paying.agent.fetch(`${API}/account/subscription`, {
            method: "PUT",
            headers: CSRF,
            body: { planId: "premium", previewToken: token },
          }),
          "account_deletion_scheduled",
          "changing plan",
        );
        status(
          await post(paying.agent, "/billing/payment-method/setup"),
          201,
          "replacing the card (allowed)",
        );
        const effect = (
          await succeeds(() => paying.agent.api.listPrivacyRequests(), "GET /privacy/requests")
        ).items.find((item) => item.id === request.id)?.membership;
        check(
          effect?.status === "ending" || effect?.status === "stopping",
          "the member made the membership renew during the deletion",
          {
            expected: "ending (renewals stopped)",
            observed: JSON.stringify(effect ?? null),
          },
        );
      } finally {
        await paying.agent.api.cancelAccountDeletion().catch(() => undefined);
      }
      // Keeping the account lifts the rule at once.
      await succeeds(
        () => paying.agent.api.resumeMembership(),
        "resuming once the account is kept",
      );

      // No membership: a checkout started before the request cannot be confirmed, nor a new one started.
      const bare = await env.bareHolder("deletion-blocks-checkout");
      const before = await succeeds(
        () => bare.agent.api.startCheckout({ body: { planId: "basic" } }),
        "a checkout started before the deletion",
      );
      check(before.clientSecret, "no client secret");
      await succeeds(
        () => bare.agent.api.elevate({ body: { password: bare.password } }),
        "POST /session/elevation",
      );
      await succeeds(() => bare.agent.api.requestAccountDeletion(), "POST /account/deletion");
      try {
        problem(
          await post(bare.agent, "/billing/checkout", { planId: "basic" }),
          "account_deletion_scheduled",
          "starting a checkout",
        );
        await confirmCard(bare.agent, before.clientSecret, card, "the earlier checkout's card");
        problem(
          await post(bare.agent, `/billing/checkout/${before.id}/confirm`),
          "account_deletion_scheduled",
          "confirming a checkout started before the deletion",
        );
        equal(
          (await succeeds(() => bare.agent.api.getAccount(), "GET /account")).membership?.status,
          "none",
          "membership during the deletion",
        );
      } finally {
        await bare.agent.api.cancelAccountDeletion().catch(() => undefined);
      }
    },
  },
  {
    id: "privacy.deletion.emails",
    area: "privacy",
    title:
      "A deletion says so by email: scheduling sends account-deletion-scheduled with its date and a link to Account › Privacy, keeping the account sends account-deletion-canceled, and the renewals it stopped send no cancellation email (an ordinary cancel still does)",
    needs: [needs.mailbox, needs.fakePayments],
    timeoutMs: 180_000,
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const account = await env.bareHolder("deletion-emails");
      const agent = account.agent;
      const terms = (await succeeds(() => agent.api.listPrivacyRequests(), "GET /privacy/requests"))
        .terms;
      if (terms.deletionCoolingOffSec < 8) {
        ctx.skip(
          `the cooling-off period (${terms.deletionCoolingOffSec} s) is too short to keep the account inside it`,
        );
      }
      // A member: a deletion then stops the renewals (through billing's cancel).
      await subscribe(ctx, agent, {
        planId: "basic",
        card: labelledCard("visa", ctx.options.runId, "deletion-emails"),
      });
      await succeeds(
        () => agent.api.elevate({ body: { password: account.password } }),
        "POST /session/elevation",
      );
      const request = await succeeds(
        () => agent.api.requestAccountDeletion(),
        "POST /account/deletion",
      );
      check(request.scheduledFor, "a deletion without scheduledFor");
      const [scheduled] = await awaitMail(ctx, agent, account.email, "account-deletion-scheduled");
      check(scheduled, "no account-deletion-scheduled email");
      const when = new Date(request.scheduledFor);
      const dated = [
        // Emails say dates as the member app does ("December 7, 2026", docs/DESIGN_SYSTEM.md).
        when.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }),
        `${when.getUTCDate()} ${when.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} ${when.getUTCFullYear()}`,
        request.scheduledFor.slice(0, 10),
      ];
      check(
        dated.some((form) => scheduled.text.includes(form)),
        "the deletion email does not say when the account will be deleted",
        { expected: `the date ${dated.join(" or ")}`, observed: scheduled.text.slice(0, 400) },
      );
      const privacyPage = scheduled.links.find((link) => {
        try {
          return new URL(link).pathname === "/account/privacy";
        } catch {
          return false;
        }
      });
      check(
        privacyPage,
        "the deletion email has no link to Account › Privacy (to keep the account)",
        {
          observed: scheduled.links.join(", ") || "no links",
        },
      );
      check(agent.sameDeployment(privacyPage), "the deletion email links to another origin", {
        observed: privacyPage,
      });
      await ctx.eventually("the deletion's email is recorded as sent", async () => {
        const email = (
          await succeeds(() => agent.api.listPrivacyRequests(), "GET /privacy/requests")
        ).items.find((item) => item.id === request.id)?.email;
        return email === "sent"
          ? { done: true, value: email }
          : { done: false, observed: `email ${String(email)}` };
      });
      await succeeds(() => agent.api.cancelAccountDeletion(), "DELETE /account/deletion (keep)");
      await awaitMail(ctx, agent, account.email, "account-deletion-canceled");
      // The renewals the deletion stopped sent no "your membership ends" email.
      const box = await mailboxNow(agent, account.email);
      check(
        !box.some((message) => message.template === "cancellation"),
        "a cancellation email was sent for the renewals a deletion stopped",
        {
          expected: "account-deletion-scheduled and account-deletion-canceled only",
          observed: box.map((message) => message.template).join(", "),
        },
      );
      // An ordinary cancel still sends one.
      await succeeds(() => agent.api.resumeMembership(), "resume the membership");
      await succeeds(() => agent.api.cancelMembership(), "cancel the membership (ordinary)");
      await awaitMail(ctx, agent, account.email, "cancellation");
    },
  },
  {
    id: "privacy.deletion",
    area: "privacy",
    title:
      "Delete account: needs a fresh proof, one at a time, scheduled after a cooling-off period, cancellable meanwhile",
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("deletion");
      const agent = account.agent;
      await rejects(
        () => agent.api.requestAccountDeletion(),
        "reauthentication_required",
        "deletion without a fresh proof",
      );
      await succeeds(
        () => agent.api.elevate({ body: { password: account.password } }),
        "POST /session/elevation",
      );
      const raced = await Promise.all(
        [1, 2].map(() => agent.fetch(`${API}/account/deletion`, { method: "POST", headers: CSRF })),
      );
      const scheduled = raced.filter((result) => result.status === 202);
      equal(scheduled.length, 1, "deletions scheduled by two concurrent requests");
      const refused = raced.find((result) => result.status !== 202);
      check(refused, "both concurrent deletions answered 202");
      problem(refused, "privacy_request_pending", "the second concurrent deletion");
      const request = scheduled[0]?.json<{
        status: string;
        scheduledFor: string | null;
        requestedAt: string;
        membership: { status: string } | null;
      }>();
      equal(request?.status, "scheduled", "deletion status");
      equal(
        request?.membership?.status,
        "none",
        "the deletion's membership effect for an account without one",
      );
      check(
        request?.scheduledFor && Date.parse(request.scheduledFor) > Date.parse(request.requestedAt),
        "no cooling-off period",
        {
          observed: JSON.stringify(request),
        },
      );
      if (request?.scheduledFor) {
        const cooling = (Date.parse(request.scheduledFor) - Date.parse(request.requestedAt)) / 1000;
        const terms = (
          await succeeds(() => agent.api.listPrivacyRequests(), "GET /privacy/requests")
        ).terms;
        check(
          Math.abs(cooling - terms.deletionCoolingOffSec) <= 1,
          "the deletion's cooling-off is not the one the terms state",
          {
            expected: `${terms.deletionCoolingOffSec} s (terms.deletionCoolingOffSec)`,
            observed: `${cooling} s`,
          },
        );
        ctx.note(`cooling-off: ${Math.round(cooling)} s`);
      }
      await succeeds(() => agent.api.cancelAccountDeletion(), "DELETE /account/deletion");
      const list = await succeeds(() => agent.api.listPrivacyRequests(), "GET /privacy/requests");
      equal(
        list.items.find((item) => item.kind === "deletion")?.status,
        "canceled",
        "deletion after cancelling",
      );
      await rejects(() => agent.api.cancelAccountDeletion(), "not_found", "cancelling twice");
      const fresh = await ctx.env.login(account, "deletion-after");
      check(
        (await succeeds(() => fresh.api.getSession(), "GET /session")).authenticated,
        "the account no longer signs in",
      );
    },
  },
  {
    id: "privacy.deletion.erasure",
    area: "privacy",
    title:
      "When the cooling-off period ends the account is erased: its sessions end, sign-in is refused, its address is free again; nothing is left in progress (health), and the audit log keeps staff's entries with the member erased from them",
    timeoutMs: 240_000,
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("erasure");
      const agent = account.agent;
      const terms = (await succeeds(() => agent.api.listPrivacyRequests(), "GET /privacy/requests"))
        .terms;
      if (terms.deletionCoolingOffSec > 60) {
        ctx.skip(
          `the cooling-off period is ${terms.deletionCoolingOffSec} s (GET /privacy/requests terms; WEBFLIX_DELETION_COOLING_OFF_SEC, 14 days by default) and the suite waits at most 60 s: a conformance deployment sets it to 30 s or less, with a scheduler tick of 30 s or less (WEBFLIX_SCHEDULER_INTERVAL_SEC on Node, the Worker's cron)`,
        );
      }
      await succeeds(
        () => agent.api.elevate({ body: { password: account.password } }),
        "POST /session/elevation",
      );
      const request = await succeeds(
        () => agent.api.requestAccountDeletion(),
        "POST /account/deletion",
      );
      check(request.scheduledFor, "a deletion without scheduledFor");
      const coolingSec = (Date.parse(request.scheduledFor) - Date.now()) / 1000;
      if (coolingSec > 60) {
        await succeeds(
          () => agent.api.cancelAccountDeletion(),
          "cancel the deletion (the suite will not wait)",
        );
        ctx.skip(
          `the cooling-off period is ${Math.round(coolingSec)} s (WEBFLIX_DELETION_COOLING_OFF_SEC, 14 days by default) and the suite waits at most 60 s: a conformance deployment sets it to 30 s or less, with a scheduler tick of 30 s or less (WEBFLIX_SCHEDULER_INTERVAL_SEC on Node, the Worker's cron)`,
        );
      }
      const budget = Math.ceil(coolingSec * 1000) + 120_000;
      const accountId = account.session.account.id;
      // Staff read the member before the erasure: that entry must survive it, pseudonymised.
      const staff = (await ctx.env.staffIssuer()).available;
      const read = staff
        ? await audited(
            async () => (await staffClient(ctx, "support")).getMember({ params: { accountId } }),
            "GET /members/:id (support reads the member before the erasure)",
          )
        : null;
      const other = await ctx.env.login(account, "erasure-other");
      const before = await succeeds(
        () => other.api.getSession(),
        "GET /session before the erasure",
      );
      check(before.authenticated, "the account's other device is not signed in before the erasure");
      // While the erasure runs (`processing`) the account cannot be kept nor asked to be deleted
      // again. It usually lasts less than a poll; when a poll sees it, it is asserted.
      let caughtInProgress = false;
      const erased = await ctx.eventually(
        "the account is erased (its session ends)",
        async () => {
          const mine = await agent.fetch(`${API}/privacy/requests`);
          if (mine.status === 200) {
            const state = mine
              .json<{ items: PrivacyRequest[] }>()
              .items.find((item) => item.id === request.id)?.status;
            if (state === "processing" && !caughtInProgress) {
              caughtInProgress = true;
              await expectErasureLocked(agent);
            }
          }
          const state = await succeeds(() => other.api.getSession(), "GET /session");
          return state.authenticated
            ? { done: false, observed: "still signed in" }
            : { done: true, value: null };
        },
        { timeoutMs: budget, intervalMs: 1_000 },
      );
      ctx.note(
        `erased ${Math.round(erased.elapsedMs / 1000)} s after the request${caughtInProgress ? " (seen in progress: neither kept nor asked again)" : " (the erasure ran between two polls: its in-progress state was not observable)"}`,
      );
      await signedOutEverywhere(agent);
      // Sign-in is refused: no password finds the account any more.
      await rejects(
        () =>
          ctx.env
            .knownDevice(account, ctx.agent("erasure-signin"))
            .api.login({ body: { email: account.email, password: account.password } }),
        "invalid_credentials",
        "signing in to the erased account",
      );
      const status_ = await succeeds(
        () => agent.api.getEmailStatus({ query: { email: account.email } }),
        "GET /auth/email-status",
      );
      equal(status_.next, "signup", "the erased account's address");
      const list = await agent.fetch(`${API}/privacy/requests`);
      check(
        list.status === 401 || list.status === 403,
        "the erased account's requests are still served",
        { exchange: list.exchange },
      );
      if (!read) {
        ctx.note(
          "no staff token: the audit log and the health report after the erasure are not checked",
        );
        return;
      }
      const admin = await staffClient(ctx, "admin");
      // Nothing in progress once it finished (privacy review H2): the health report says so.
      await ctx.eventually(
        "GET /system/health privacy.erasuresInProgress returns to 0",
        async () => {
          const health = await succeeds(() => admin.getSystemHealth(), "GET /system/health");
          const privacy = health.privacy;
          return privacy.erasuresInProgress === 0
            ? { done: true, value: privacy }
            : {
                done: false,
                observed: `${privacy.erasuresInProgress} in progress, the oldest since ${privacy.oldestErasureInProgressAt} (${privacy.oldestErasureInProgressAgeSec} s)`,
              };
        },
      );
      // The audit log keeps what staff did, no longer naming the member (privacy review M5).
      const byTarget = await succeeds(
        () => admin.listAuditLog({ query: { targetId: accountId, limit: 100 } }),
        "GET /audit?targetId=<the erased account>",
      );
      equal(byTarget.items.length, 0, "audit entries still naming the erased account");
      const kept = await succeeds(
        () => admin.listAuditLog({ query: { requestId: read.requestId } }),
        "GET /audit?requestId= (the staff read before the erasure)",
      );
      const entry = kept.items[0];
      check(entry, "the staff member's entry was deleted with the member", {
        expected: `an entry with requestId ${read.requestId}`,
      });
      check(
        entry.target.id.startsWith("erased:") && !entry.target.id.includes(accountId),
        "the staff member's entry still names the erased member",
        { expected: "target.id erased:…", observed: entry.target.id },
      );
      equal(entry.targetLabel, ERASED_MEMBER_LABEL, "the entry's targetLabel after the erasure");
    },
  },
];

/**
 * An erasure in progress: the account can no longer be kept (`DELETE /account/deletion` →
 * not_found) nor asked to be deleted again (`privacy_request_pending`). The session may already
 * be gone (the lock ends every session): then `unauthenticated`, never a success.
 */
async function expectErasureLocked(agent: Agent): Promise<void> {
  const keep = await agent.fetch(`${API}/account/deletion`, { method: "DELETE", headers: CSRF });
  const keepCode = keep.status >= 400 ? keep.json<{ code?: string }>().code : "(success)";
  check(
    keepCode === "not_found" || keepCode === "unauthenticated",
    "an erasure in progress could still be cancelled",
    { expected: "404 not_found (or 401 once the lock ended the session)", exchange: keep.exchange },
  );
  const again = await agent.fetch(`${API}/account/deletion`, { method: "POST", headers: CSRF });
  const againCode = again.status >= 400 ? again.json<{ code?: string }>().code : "(success)";
  check(
    againCode === "privacy_request_pending" || againCode === "unauthenticated",
    "a deletion could be asked again during the erasure",
    {
      expected: "409 privacy_request_pending (or 401 once the lock ended the session)",
      exchange: again.exchange,
    },
  );
}

async function signedOutEverywhere(agent: Agent): Promise<void> {
  const state = await succeeds(() => agent.api.getSession(), "GET /session");
  equal(state.authenticated, false, "the requesting device after the erasure");
}
