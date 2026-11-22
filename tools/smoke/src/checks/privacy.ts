/**
 * Milestone 2 behaviour collection and privacy (docs/BLUEPRINT-M2.md §6): events accepted,
 * stamped by the server and readable back; nothing from a kids profile; consent as the
 * deployment's mode says; the data export; account deletion with its cooling-off period.
 * Events are read back through `GET /diagnostics/events` (non-production).
 */
import {
  type ConsentState,
  DataExport,
  type LakeEvent,
  type RecentEventsQuery,
} from "@webflix/contracts";
import type { TestAccount } from "../env.ts";
import { check, equal, fail, problem, rejects, status, succeeds } from "../expect.ts";
import { type Agent, isApiError } from "../http.ts";
import { awaitMail } from "../mail.ts";
import { deviceId, EventStream } from "../telemetry.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, CSRF, maturityRank } from "./util.ts";

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
      "Download your data: needs a fresh proof, one at a time, completes with a signed link (emailed) to a document holding the account, its profiles and events; only its account may open it",
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
      const requestId = (started[0]?.json<{ id: string }>() ?? { id: "" }).id;
      const { value: done } = await ctx.eventually("the export completes", async () => {
        const list = await succeeds(() => agent.api.listPrivacyRequests(), "GET /privacy/requests");
        const request = list.items.find((item) => item.id === requestId);
        if (request?.status === "failed")
          fail("the export failed", { observed: JSON.stringify(request) });
        return request?.status === "completed" && request.downloadUrl
          ? { done: true, value: request }
          : { done: false, observed: request ? request.status : "not listed" };
      });
      const link = agent.ownPath(done.downloadUrl ?? "");
      check(link, "the export link points to another origin", {
        observed: String(done.downloadUrl),
      });
      check(
        done.expiresAt && Date.parse(done.expiresAt) > Date.now(),
        "the export link has no future expiry",
      );
      const download = await agent.fetch(link);
      status(download, 200, "GET the export link");
      check(
        /attachment/i.test(download.headers.get("Content-Disposition") ?? ""),
        "the export is not served as an attachment",
        {
          observed: download.headers.get("Content-Disposition") ?? "(absent)",
          exchange: download.exchange,
        },
      );
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
      equal(document.requestId, requestId, "export: requestId");
      check(
        document.profiles.some((profile) => profile.name === "Holder"),
        "export: the profile is missing",
      );
      check(
        "billing" in document.areas && "identity" in document.areas,
        "export: an area's part is missing",
        {
          observed: Object.keys(document.areas).join(", "),
        },
      );
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
        const [mail] = await awaitMail(ctx, agent, account.email, "data-export-ready");
        check(
          mail?.links.some(
            (candidate) => agent.ownPath(candidate)?.split("?")[0] === link.split("?")[0],
          ),
          "the export email does not carry the link",
          { observed: mail?.links.join(", ") },
        );
      }
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
      }>();
      equal(request?.status, "scheduled", "deletion status");
      check(
        request?.scheduledFor && Date.parse(request.scheduledFor) > Date.parse(request.requestedAt),
        "no cooling-off period",
        {
          observed: JSON.stringify(request),
        },
      );
      if (request?.scheduledFor) {
        ctx.note(
          `cooling-off: ${Math.round((Date.parse(request.scheduledFor) - Date.parse(request.requestedAt)) / 1000)} s`,
        );
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
      "When the cooling-off period ends the account is erased: its sessions end and its address is free again",
    timeoutMs: 240_000,
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("erasure");
      const agent = account.agent;
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
      const other = await ctx.env.login(account, "erasure-other");
      const before = await succeeds(
        () => other.api.getSession(),
        "GET /session before the erasure",
      );
      check(before.authenticated, "the account's other device is not signed in before the erasure");
      const erased = await ctx.eventually(
        "the account is erased (its session ends)",
        async () => {
          const state = await succeeds(() => other.api.getSession(), "GET /session");
          return state.authenticated
            ? { done: false, observed: "still signed in" }
            : { done: true, value: null };
        },
        { timeoutMs: budget, intervalMs: 1_000 },
      );
      ctx.note(`erased ${Math.round(erased.elapsedMs / 1000)} s after the request`);
      await signedOutEverywhere(agent);
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
    },
  },
];

async function signedOutEverywhere(agent: Agent): Promise<void> {
  const state = await succeeds(() => agent.api.getSession(), "GET /session");
  equal(state.authenticated, false, "the requesting device after the erasure");
}
