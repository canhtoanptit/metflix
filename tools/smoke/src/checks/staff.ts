/**
 * The staff API (docs/BLUEPRINT-M2.md §8.3, `/api/admin/v1`) with bearer tokens minted at the
 * development staff issuer for each role's persona: roles refused route by route, a refund
 * retried under its idempotency key refunding once, and an audit entry (found by the request id
 * the suite sent) for every action, a curated row included.
 */
import {
  ADMIN_API_BASE_PATH,
  type AdminApiClient,
  AUDIT_READ_ACTIONS,
  type AuditLogEntry,
  STAFF_ROLES,
  type StaffRole,
} from "@webflix/contracts";
import { check, equal, fail, problem, rejects, succeeds } from "../expect.ts";
import { capture } from "../http.ts";
import { lockedProfile } from "../limits.ts";
import { awaitMail } from "../mail.ts";
import { needs } from "../needs.ts";
import { clientCredentialsToken, DEV_JOBS_CLIENT, STAFF_PERSONAS, staffTokens } from "../oidc.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { memberWithPaidInvoice } from "./billing.ts";
import { browseAll, cardsOfRow, unique } from "./util.ts";

type Persona = keyof typeof STAFF_PERSONAS;

/** An email address written out (a masked shape like `s***@s***` is not one). */
const EMAIL_ADDRESS = /[^\s@*"]+@[^\s@*"]+\.[^\s@*"]+/;

/** `SystemHealth.privacy`: three backlogs, each a count, its oldest instant and age. */
const PRIVACY_HEALTH_FIELDS = [
  "pendingErasures",
  "oldestPendingErasureAt",
  "oldestPendingErasureAgeSec",
  "waitingExports",
  "oldestWaitingExportAt",
  "oldestWaitingExportAgeSec",
  "erasuresInProgress",
  "oldestErasureInProgressAt",
  "oldestErasureInProgressAgeSec",
] as const;

async function staff(
  ctx: CheckContext,
  persona: Persona,
  label = persona,
): Promise<AdminApiClient> {
  // Asked for before every call: a long run renews it as it nears its expiry.
  const persona_ = STAFF_PERSONAS[persona];
  await ctx.env.staffToken(persona_);
  return ctx.agent(`staff-${label}`).staffApi(() => ctx.env.staffToken(persona_));
}

/** Run a typed staff call that must succeed; also return the request id it was sent with. */
async function audited<T>(
  call: () => Promise<T>,
  what: string,
): Promise<{ value: T; requestId: string }> {
  const captured = await capture(() => succeeds(call, what));
  if (!captured.ok) throw captured.error;
  const last = captured.exchanges[captured.exchanges.length - 1];
  check(last, `${what}: no request was made`);
  return { value: captured.value, requestId: last.requestId };
}

/** The audit entries the admin sees for a target (newest first, every page). */
async function auditOf(
  admin: AdminApiClient,
  query: { targetId: string; targetType?: string },
): Promise<AuditLogEntry[]> {
  const entries: AuditLogEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await succeeds(
      () => admin.listAuditLog({ query: { ...query, limit: 100, ...(cursor ? { cursor } : {}) } }),
      "GET /audit",
    );
    entries.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return entries;
}

/** Each action has its own entry: found by the request id, settled `succeeded`, with its reason. */
function expectAudited(
  entries: AuditLogEntry[],
  actions: { requestId: string; reason: string | null; what: string }[],
  actorId: string,
): void {
  for (const action of actions) {
    const entry = entries.find((candidate) => candidate.requestId === action.requestId);
    if (!entry) {
      fail(`no audit entry for ${action.what}`, {
        expected: `an entry with requestId ${action.requestId}`,
        observed:
          entries.map((candidate) => `${candidate.action} (${candidate.requestId})`).join(", ") ||
          "no entries",
      });
    }
    equal(entry.outcome, "succeeded", `audit outcome of ${action.what}`);
    equal(entry.reason, action.reason, `audit reason of ${action.what}`);
    equal(entry.actor.type, "staff", `audit actor type of ${action.what}`);
    equal(entry.actor.id, actorId, `audit actor of ${action.what}`);
  }
}

async function subjectOf(api: AdminApiClient): Promise<string> {
  return (await succeeds(() => api.getStaffSelf(), "GET /me")).subject;
}

/** One route per role (and `GET /me`, which any staff token may call). */
const SAMPLE: {
  role: StaffRole | "any";
  what: string;
  call: (api: AdminApiClient) => Promise<unknown>;
}[] = [
  { role: "any", what: "GET /me", call: (api) => api.getStaffSelf() },
  {
    role: "support",
    what: "GET /members",
    call: (api) => api.searchMembers({ query: { q: "smoke-role-probe@" } }),
  },
  { role: "billing", what: "GET /plans", call: (api) => api.listAdminPlans() },
  { role: "content", what: "GET /editorial/collections", call: (api) => api.listCollections() },
  { role: "experiments", what: "GET /experiments", call: (api) => api.listExperiments() },
  { role: "admin", what: "GET /system/health", call: (api) => api.getSystemHealth() },
  { role: "admin", what: "GET /audit", call: (api) => api.listAuditLog({ query: { limit: 1 } }) },
];

export const staffChecks: CheckDefinition[] = [
  {
    id: "staff.roles",
    area: "staff",
    title:
      "Staff roles: each sampled route admits its role and admin and refuses every other role with staff_role_required; no token, a forged one, an ID token or a member's cookie is unauthenticated",
    needs: [needs.staffIssuer],
    async run(ctx: CheckContext) {
      const personas = Object.keys(STAFF_PERSONAS) as Persona[];
      let calls = 0;
      for (const persona of personas) {
        const api = await staff(ctx, persona);
        for (const route of SAMPLE) {
          calls += 1;
          const allowed = route.role === "any" || persona === "admin" || persona === route.role;
          const what = `${route.what} as ${persona}`;
          if (allowed) {
            await succeeds(() => route.call(api), what);
          } else {
            const refused = await rejects(() => route.call(api), "staff_role_required", what);
            equal(refused.problem.requiredRole, route.role, `${what}: requiredRole`);
          }
        }
        if (persona === "none" || persona === "other-client") {
          equal(
            (await succeeds(() => api.getStaffSelf(), `GET /me as ${persona}`)).roles.length,
            0,
            `roles of ${persona}`,
          );
        }
      }
      for (const role of STAFF_ROLES) {
        const me = await succeeds(
          () => staff(ctx, role).then((api) => api.getStaffSelf()),
          `GET /me as ${role}`,
        );
        equal(me.roles.join(","), role, `roles of the ${role} persona`);
      }
      ctx.note(`${calls} role checks over ${SAMPLE.length} routes and ${personas.length} personas`);

      const probe = ctx.agent("staff-unauthenticated");
      const me = `${ADMIN_API_BASE_PATH}/me`;
      problem(await probe.fetch(me), "unauthenticated", "the staff API without a token");
      problem(
        await probe.fetch(me, { headers: { Authorization: "Bearer not.a.token" } }),
        "unauthenticated",
        "a forged bearer token",
      );
      const tokens = await staffTokens(ctx.agent("staff-id-token"), STAFF_PERSONAS.admin);
      if (tokens.idToken) {
        problem(
          await probe.fetch(me, { headers: { Authorization: `Bearer ${tokens.idToken}` } }),
          "unauthenticated",
          "an ID token presented as an access token",
        );
      }
      const member = await ctx.env.bareSignup("staff-cookie");
      problem(
        await member.agent.fetch(me),
        "unauthenticated",
        "a member's session cookie on the staff API",
      );
      // Mutations need the client header, as on the member API.
      problem(
        await probe.fetch(`${ADMIN_API_BASE_PATH}/plans/sync`, {
          method: "POST",
          headers: { Authorization: `Bearer ${await ctx.env.staffToken(STAFF_PERSONAS.admin)}` },
          body: { reason: "smoke: no client header" },
        }),
        "csrf_check_failed",
        "a staff mutation without the client header",
      );
      // A staff token never opens a member route.
      problem(
        await probe.fetch("/api/v1/account", {
          headers: { Authorization: `Bearer ${await ctx.env.staffToken(STAFF_PERSONAS.admin)}` },
        }),
        "unauthenticated",
        "a staff token on a member route",
      );
    },
  },
  {
    id: "staff.service-account",
    area: "staff",
    title:
      "A job's service account (client credentials, no person behind it) holds exactly its roles and opens the operator routes; a wrong secret gets no token, a member's session opens no operator route and the job's token no member route",
    needs: [needs.staffIssuer],
    async run(ctx: CheckContext) {
      const agent = ctx.agent("staff-job");
      const granted = await clientCredentialsToken(agent, DEV_JOBS_CLIENT);
      if (granted.result.status !== 200) {
        const error = String(granted.json.error ?? "");
        if (error === "unauthorized_client" || error === "invalid_client") {
          ctx.skip(
            `the staff issuer has no service client ${DEV_JOBS_CLIENT.id} with the client-credentials grant (${granted.result.status} ${error}): its token endpoint is the development issuer's (WEBFLIX_DEV_CLIENTS.staffJobs); against Keycloak the job's client is the deployment's own`,
          );
        }
        fail("the client-credentials grant failed", {
          observed: `${granted.result.status} ${granted.result.exchange.responseBody ?? ""}`,
          exchange: granted.result.exchange,
        });
      }
      const token = granted.json.access_token;
      check(typeof token === "string", "no access token");
      equal(String(granted.json.token_type).toLowerCase(), "bearer", "token_type");
      check(
        !("refresh_token" in granted.json) && !("id_token" in granted.json),
        "a service account's grant must carry an access token only",
        { observed: Object.keys(granted.json).join(", ") },
      );
      const wrong = await clientCredentialsToken(ctx.agent("staff-job-wrong"), {
        id: DEV_JOBS_CLIENT.id,
        secret: `${DEV_JOBS_CLIENT.secret}-wrong`,
      });
      check(
        wrong.result.status === 401 && typeof wrong.json.access_token !== "string",
        "a wrong client secret got a token",
        {
          expected: "401 invalid_client",
          observed: `${wrong.result.status} ${wrong.result.exchange.responseBody ?? ""}`,
          exchange: wrong.result.exchange,
        },
      );
      // The run's job token, renewed near its expiry like every staff token.
      const api = agent.staffApi(() => ctx.env.jobToken());
      const me = await succeeds(() => api.getStaffSelf(), "GET /me with the job's token");
      equal([...me.roles].sort().join(","), "admin,experiments", "the service account's roles");
      await succeeds(
        () => api.listPendingExports({ query: {} }),
        "GET /system/privacy/exports (job)",
      );
      await succeeds(
        () => api.listPendingErasures({ query: {} }),
        "GET /system/privacy/erasures (job)",
      );
      await succeeds(() => api.getRecommendationStatus(), "GET /system/recommendations (job)");
      await succeeds(() => api.listExperiments(), "GET /experiments (job)");
      const member = await ctx.env.bareSignup("staff-job-member");
      for (const path of [
        "/system/privacy/exports",
        "/system/privacy/erasures",
        "/system/recommendations",
      ]) {
        problem(
          await member.agent.fetch(`${ADMIN_API_BASE_PATH}${path}`),
          "unauthenticated",
          `a member's session on ${path}`,
        );
      }
      problem(
        await ctx.agent("staff-job-member-route").fetch("/api/v1/account", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        "unauthenticated",
        "the job's token on a member route",
      );
    },
  },
  {
    id: "staff.refund",
    area: "staff",
    title:
      "A staff refund retried under its idempotency key refunds once (the same refund answered again); other parameters or another staff member with the key conflict; each settled refund is audited with its amount and the member's address",
    needs: [needs.staffIssuer, needs.fakePayments],
    async run(ctx: CheckContext) {
      const { account, invoice } = await memberWithPaidInvoice(ctx, "refund");
      const accountId = account.session.account.id;
      const billing = await staff(ctx, "billing");
      const admin = await staff(ctx, "admin");
      const actorId = await subjectOf(billing);
      const paid = invoice.amountPaid.amountMinor;
      const part = Math.floor(paid / 3);
      const key = `smoke-${ctx.options.runId}-${unique("refund")}`.slice(0, 64);
      const body = {
        invoiceId: invoice.id,
        amount: { amountMinor: part, currency: invoice.amountPaid.currency },
        reason: "smoke: refund retried",
        idempotencyKey: key,
      };
      const first = await audited(
        () => billing.refundInvoice({ params: { accountId }, body }),
        "POST /members/:id/refunds",
      );
      equal(first.value.amount.amountMinor, part, "refunded amount");
      equal(first.value.status, "succeeded", "refund status");
      const retried = await succeeds(
        () => billing.refundInvoice({ params: { accountId }, body }),
        "the same refund retried (same key)",
      );
      equal(retried.id, first.value.id, "a retry answers the first refund");
      const conflict = await rejects(
        () =>
          billing.refundInvoice({
            params: { accountId },
            body: { ...body, amount: { ...body.amount, amountMinor: part + 1 } },
          }),
        "staff_action_conflict",
        "the key with another amount",
      );
      // The conflict names the earlier attempt's audit entry (found by its request id).
      const earlier = await succeeds(
        () => admin.listAuditLog({ query: { requestId: first.requestId } }),
        "GET /audit?requestId= (the first refund)",
      );
      equal(earlier.items.length, 1, "audit entries of the first refund's request");
      equal(conflict.problem.auditId, earlier.items[0]?.id, "staff_action_conflict.auditId");
      await rejects(
        () => admin.refundInvoice({ params: { accountId }, body }),
        "staff_action_conflict",
        "the key from another staff member",
      );
      const once = (
        await succeeds(() => account.agent.api.listInvoices({ query: {} }), "the member's invoices")
      ).items.find((item) => item.id === invoice.id);
      equal(
        once?.amountRefunded.amountMinor,
        part,
        "refunded on the invoice (once, not per retry)",
      );
      equal(once?.status, "paid", "a refunded invoice stays paid");
      const rest = await audited(
        () =>
          billing.refundInvoice({
            params: { accountId },
            body: {
              invoiceId: invoice.id,
              reason: "smoke: refund the rest",
              idempotencyKey: `${key.slice(0, 50)}-rest`,
            },
          }),
        "refund what remains",
      );
      equal(rest.value.amount.amountMinor, paid - part, "the rest of the invoice");
      await rejects(
        () =>
          billing.refundInvoice({
            params: { accountId },
            body: {
              invoiceId: invoice.id,
              reason: "smoke: nothing left",
              idempotencyKey: `${key.slice(0, 50)}-more`,
            },
          }),
        "checkout_state_conflict",
        "refunding a fully refunded invoice",
      );
      const after = (
        await succeeds(() => account.agent.api.listInvoices({ query: {} }), "the member's invoices")
      ).items.find((item) => item.id === invoice.id);
      equal(after?.amountRefunded.amountMinor, paid, "fully refunded");
      const entries = await auditOf(admin, { targetId: accountId });
      expectAudited(
        entries,
        [
          { requestId: first.requestId, reason: body.reason, what: "the first refund" },
          {
            requestId: rest.requestId,
            reason: "smoke: refund the rest",
            what: "the second refund",
          },
        ],
        actorId,
      );
      const action = entries.find((entry) => entry.requestId === first.requestId)?.action;
      const settled = entries.filter(
        (entry) => entry.action === action && entry.outcome === "succeeded",
      );
      equal(settled.length, 2, "succeeded refund entries (a retry adds none)");
      // Readable at a glance (UX review 2.17): the amount and the member's address.
      for (const [requestId, amount, what] of [
        [first.requestId, part, "the first refund"],
        [rest.requestId, paid - part, "the second refund"],
      ] as const) {
        const entry = entries.find((candidate) => candidate.requestId === requestId);
        equal(entry?.facts.amount?.amountMinor, amount, `${what}'s audit facts.amount`);
        equal(entry?.kind, "action", `${what}'s audit kind`);
        equal(
          entry?.targetLabel,
          account.email,
          `${what}'s audit targetLabel (the member's address)`,
        );
      }
    },
  },
  {
    id: "staff.support-audit",
    area: "staff",
    title:
      "Support actions act and are audited: reading a member, removing a PIN, recording a consent withdrawal (a grant is the member's own: consent_grant_member_only), sending a password reset, signing the member out everywhere",
    needs: [needs.staffIssuer],
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const account = await env.bareHolder("support");
      const accountId = account.session.account.id;
      const locked = await lockedProfile(env, account, "Locked");
      const otherDevice = await env.login(account, "support-other-device");
      const support = await staff(ctx, "support");
      const admin = await staff(ctx, "admin");
      const actorId = await subjectOf(support);

      const viewed = await audited(
        () => support.getMember({ params: { accountId } }),
        "GET /members/:id",
      );
      check(
        viewed.value.profiles.some((profile) => profile.id === locked.id && profile.locked),
        "the member record does not show the locked profile",
      );
      check(!("passwordHash" in viewed.value.account), "the member record exposes a password hash");
      const pin = await audited(
        () =>
          support.removeProfilePin({
            params: { accountId, profileId: locked.id },
            body: { reason: "smoke: member forgot the PIN" },
          }),
        "DELETE /members/:id/profiles/:profileId/pin",
      );
      const profiles = await succeeds(
        () => account.agent.api.listProfiles(),
        "the member's profiles",
      );
      equal(
        profiles.items.find((profile) => profile.id === locked.id)?.isLocked,
        false,
        "the profile after its PIN was removed",
      );
      const consent = await audited(
        () =>
          support.setMemberConsent({
            params: { accountId },
            body: { purpose: "analytics", granted: false, reason: "smoke: asked on the phone" },
          }),
        "PUT /members/:id/privacy/consent",
      );
      const seen = await succeeds(() => account.agent.api.getConsent(), "the member's consent");
      equal(seen.purposes.analytics.granted, false, "analytics after the support answer");
      equal(seen.purposes.analytics.source, "support", "source of the support answer");
      // Staff record a withdrawal, never a grant: turning a purpose on is the member's own
      // answer (privacy review M4).
      await rejects(
        () =>
          support.setMemberConsent({
            params: { accountId },
            body: { purpose: "personalisation", granted: true, reason: "smoke: asked to turn on" },
          }),
        "consent_grant_member_only",
        "PUT /members/:id/privacy/consent {granted: true} (a staff grant)",
      );
      const unchanged = await succeeds(
        () => account.agent.api.getConsent(),
        "the member's consent after the refused grant",
      );
      check(
        unchanged.purposes.personalisation.source !== "support" ||
          !unchanged.purposes.personalisation.granted,
        "a staff grant turned personalisation on",
        { observed: JSON.stringify(unchanged.purposes.personalisation) },
      );
      equal(
        unchanged.purposes.personalisation.granted,
        seen.purposes.personalisation.granted,
        "personalisation after the refused grant",
      );
      const reset = await audited(
        () =>
          support.sendMemberPasswordReset({
            params: { accountId },
            body: { reason: "smoke: locked out" },
          }),
        "POST /members/:id/password-reset",
      );
      if ((await env.mailbox()).available) {
        await awaitMail(ctx, account.agent, account.email, "reset-password");
      }
      const signOut = await audited(
        () =>
          support.signOutMemberEverywhere({
            params: { accountId },
            body: { reason: "smoke: lost phone" },
          }),
        "POST /members/:id/sign-out",
      );
      for (const [agent, what] of [
        [account.agent, "the sign-up device"],
        [otherDevice, "another device"],
      ] as const) {
        const state = await succeeds(() => agent.api.getSession(), `${what}: GET /session`);
        equal(state.authenticated, false, `${what} after staff signed the member out`);
      }
      const entries = await auditOf(admin, { targetId: accountId });
      expectAudited(
        entries,
        [
          { requestId: viewed.requestId, reason: null, what: "reading the member" },
          {
            requestId: pin.requestId,
            reason: "smoke: member forgot the PIN",
            what: "removing the PIN",
          },
          {
            requestId: consent.requestId,
            reason: "smoke: asked on the phone",
            what: "recording consent",
          },
          { requestId: reset.requestId, reason: "smoke: locked out", what: "sending a reset" },
          {
            requestId: signOut.requestId,
            reason: "smoke: lost phone",
            what: "signing out everywhere",
          },
        ],
        actorId,
      );
      ctx.note(`audited: ${entries.map((entry) => entry.action).join(", ")}`);
    },
  },
  {
    id: "staff.console-reads",
    area: "staff",
    title:
      "What the console reads: title search and availability for the content role only; GET /audit/mine shows the caller's own entries without their before; GET /audit filters by request id",
    needs: [needs.staffIssuer],
    async run(ctx: CheckContext) {
      const content = await staff(ctx, "content");
      const support = await staff(ctx, "support");
      const admin = await staff(ctx, "admin");
      const { cards } = await ctx.env.catalog();
      const [first, second] = cards;
      check(first && second, "the catalogue has fewer than two titles");
      const found = await succeeds(
        () => content.searchTitles({ query: { q: first.name } }),
        "GET /titles?q= (content)",
      );
      equal(found.items[0]?.id, first.id, "the first search result for a title's own name");
      const byIds = await succeeds(
        () => content.searchTitles({ query: { ids: `${second.id},t-smoke-unknown,${first.id}` } }),
        "GET /titles?ids= (content)",
      );
      equal(
        byIds.items.map((item) => item.id).join(","),
        `${second.id},${first.id}`,
        "titles by id (in order, the unknown left out)",
      );
      const availability = await succeeds(
        () => content.getTitleAvailability({ params: { titleId: first.id } }),
        "GET /titles/:id/availability",
      );
      equal(availability.titleId, first.id, "availability's title");
      if (availability.updatedAt === null) {
        equal(availability.available, true, "a title without an override is available");
      }
      await rejects(
        () => content.getTitleAvailability({ params: { titleId: "t-smoke-unknown" } }),
        "not_found",
        "the availability of a title the catalogue lacks",
      );
      await succeeds(() => content.listTitleAvailability(), "GET /titles/availability");
      for (const [what, call] of [
        ["GET /titles", () => support.searchTitles({ query: { q: first.name } })],
        [
          "GET /titles/:id/availability",
          () => support.getTitleAvailability({ params: { titleId: first.id } }),
        ],
        ["GET /titles/availability", () => support.listTitleAvailability()],
      ] as const) {
        const refused = await rejects(call, "staff_role_required", `${what} as support`);
        equal(refused.problem.requiredRole, "content", `${what}: requiredRole`);
      }

      // The caller's own audit trail, and the request-id filter.
      const member = await ctx.env.bareSignup("console-reads");
      const viewed = await audited(
        () => support.getMember({ params: { accountId: member.session.account.id } }),
        "GET /members/:id (support)",
      );
      const supportId = await subjectOf(support);
      const mine = await succeeds(
        () => support.listOwnAuditLog({ query: { limit: 50 } }),
        "GET /audit/mine",
      );
      check(
        mine.items.some((entry) => entry.requestId === viewed.requestId),
        "GET /audit/mine lacks the caller's latest action",
        {
          expected: `an entry with requestId ${viewed.requestId}`,
        },
      );
      for (const entry of mine.items) {
        equal(entry.actor.id, supportId, "GET /audit/mine: an entry of another actor");
        equal(entry.before, null, "GET /audit/mine: an entry's before");
      }
      const byRequest = await succeeds(
        () => admin.listAuditLog({ query: { requestId: viewed.requestId } }),
        "GET /audit?requestId=",
      );
      check(
        byRequest.items.length >= 1 &&
          byRequest.items.every((entry) => entry.requestId === viewed.requestId),
        "GET /audit?requestId= returns other requests' entries (or none)",
        { observed: byRequest.items.map((entry) => entry.requestId).join(", ") },
      );
    },
  },
  {
    id: "staff.audit-privacy",
    area: "staff",
    title:
      "The audit log protects members and records reading: a search by address keeps only its shape; reading the log and the operator's export and erasure lists is recorded; kind=action holds changes only and kind=read reads only; a member target reads as the member's address; GET /system/health reports the privacy backlog",
    needs: [needs.staffIssuer],
    async run(ctx: CheckContext) {
      const support = await staff(ctx, "support");
      const admin = await staff(ctx, "admin");
      const member = await ctx.env.bareSignup("audit-privacy");
      const accountId = member.session.account.id;
      const entryOf = async (requestId: string, what: string) =>
        (
          await ctx.eventually(`the audit entry of ${what}`, async () => {
            const page = await succeeds(
              () => admin.listAuditLog({ query: { requestId } }),
              "GET /audit?requestId=",
            );
            const entry = page.items.find((candidate) => candidate.requestId === requestId);
            return entry
              ? { done: true, value: entry }
              : { done: false, observed: `${page.items.length} entries` };
          })
        ).value;

      // A search by the full address keeps the query's shape, never the address (privacy L9).
      const searched = await audited(
        () => support.searchMembers({ query: { q: member.email } }),
        "GET /members?q=<a full address>",
      );
      check(
        searched.value.items.some((item) => item.accountId === accountId),
        "the search by address did not find the member",
      );
      const search = await entryOf(searched.requestId, "the search");
      equal(search.action, "member.searched", "the search's audit action");
      equal(search.kind, "read", "the search's audit kind");
      const local = member.email.slice(0, member.email.indexOf("@"));
      const kept = JSON.stringify(search);
      check(
        !EMAIL_ADDRESS.test(search.target.id) &&
          !kept.includes(member.email) &&
          !kept.includes(local.slice(1)),
        "the search's audit entry keeps the address searched for",
        { expected: "the query's shape only (e.g. s***@s***)", observed: kept.slice(0, 400) },
      );

      // A change to the member, read back with the member's address as its label.
      const withdrawal = await audited(
        () =>
          support.setMemberConsent({
            params: { accountId },
            body: { purpose: "analytics", granted: false, reason: "smoke: audit kinds" },
          }),
        "PUT /members/:id/privacy/consent (a withdrawal)",
      );
      const change = await entryOf(withdrawal.requestId, "the withdrawal");
      equal(change.kind, "action", "the withdrawal's audit kind");
      equal(
        change.targetLabel,
        member.email,
        "the withdrawal's targetLabel (the member's address)",
      );
      equal(change.facts.purpose, "analytics", "the withdrawal's facts.purpose");
      equal(change.facts.granted, false, "the withdrawal's facts.granted");

      // Reading is recorded: the log itself and the operator's lists.
      for (const [what, action, call] of [
        ["GET /audit", "audit.read", () => admin.listAuditLog({ query: { limit: 5 } })],
        [
          "GET /system/privacy/exports",
          "privacy.exports_listed",
          () => admin.listPendingExports({ query: { limit: 1 } }),
        ],
        [
          "GET /system/privacy/erasures",
          "privacy.erasures_listed",
          () => admin.listPendingErasures({ query: { limit: 1 } }),
        ],
      ] as const satisfies readonly (readonly [string, string, () => Promise<unknown>])[]) {
        const read = await audited<unknown>(call, what);
        const entry = await entryOf(read.requestId, what);
        equal(entry.action, action, `${what}: its audit action`);
        equal(entry.kind, "read", `${what}: its audit kind`);
      }

      // The two kinds, by filter.
      const filtered = async (kind: "action" | "read", requestId: string) =>
        (
          await succeeds(
            () => admin.listAuditLog({ query: { kind, requestId } }),
            `GET /audit?kind=${kind}&requestId=`,
          )
        ).items.length;
      equal(await filtered("read", searched.requestId), 1, "kind=read: the search");
      equal(await filtered("action", searched.requestId), 0, "kind=action: the search");
      equal(await filtered("action", withdrawal.requestId), 1, "kind=action: the withdrawal");
      equal(await filtered("read", withdrawal.requestId), 0, "kind=read: the withdrawal");
      const reads: readonly string[] = AUDIT_READ_ACTIONS;
      const actions = await succeeds(
        () => admin.listAuditLog({ query: { kind: "action", limit: 100 } }),
        "GET /audit?kind=action",
      );
      const strayRead = actions.items.find((entry) => reads.includes(entry.action));
      check(!strayRead, "GET /audit?kind=action lists a read", {
        observed: strayRead ? `${strayRead.action} (${strayRead.requestId})` : "",
      });
      const readsOnly = await succeeds(
        () => admin.listAuditLog({ query: { kind: "read", limit: 100 } }),
        "GET /audit?kind=read",
      );
      const strayAction = readsOnly.items.find(
        (entry) => !reads.includes(entry.action) || entry.kind !== "read",
      );
      check(!strayAction, "GET /audit?kind=read lists something other than a read", {
        observed: strayAction ? `${strayAction.action} (${strayAction.kind})` : "",
      });

      // The privacy backlog, each count with the age of its oldest (privacy review M2, H2).
      const privacy = (await succeeds(() => admin.getSystemHealth(), "GET /system/health")).privacy;
      equal(
        Object.keys(privacy).sort().join(","),
        [...PRIVACY_HEALTH_FIELDS].sort().join(","),
        "GET /system/health privacy fields",
      );
      for (const [count, at, age] of [
        ["pendingErasures", "oldestPendingErasureAt", "oldestPendingErasureAgeSec"],
        ["waitingExports", "oldestWaitingExportAt", "oldestWaitingExportAgeSec"],
        ["erasuresInProgress", "oldestErasureInProgressAt", "oldestErasureInProgressAgeSec"],
      ] as const) {
        const waiting = privacy[count] > 0;
        check(
          (privacy[at] !== null) === waiting && (privacy[age] !== null) === waiting,
          `GET /system/health privacy.${count}: the oldest is given exactly when something waits`,
          { observed: JSON.stringify(privacy) },
        );
      }
      ctx.note(`privacy backlog: ${JSON.stringify(privacy)}`);
    },
  },
  {
    id: "staff.curated-row",
    area: "staff",
    title:
      "A curated row staff publish appears on members' home page and goes when deleted; both changes are audited",
    needs: [needs.staffIssuer],
    tags: ["exclusive"],
    timeoutMs: 240_000,
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const content = await staff(ctx, "content");
      const admin = await staff(ctx, "admin");
      const actorId = await subjectOf(content);
      const viewer = await env.isolatedViewer("curated", { member: false });
      const { cards } = await env.catalog();
      const titleIds = cards
        .filter((card) => card.maturity !== "18+")
        .slice(-3)
        .map((card) => card.id);
      check(titleIds.length === 3, "not enough titles for a curated row");
      const name = `Smoke picks ${ctx.options.runId}`;
      const created = await audited(
        () =>
          content.createCollection({
            body: {
              name,
              description: null,
              view: "home",
              position: 2,
              titleIds,
              status: "published",
              reason: "smoke: curated row",
            },
          }),
        "POST /editorial/collections",
      );
      const collectionId = created.value.id;
      let deleted: { requestId: string } | null = null;
      try {
        const appeared = await ctx.eventually(
          "the curated row on the home page",
          async () => {
            const { rows } = await browseAll(viewer.agent, "home");
            const row = rows.find(
              (candidate) => candidate.kind === "collection" && candidate.title === name,
            );
            return row
              ? { done: true, value: row }
              : { done: false, observed: `${rows.length} rows, none named ${name}` };
          },
          { timeoutMs: 100_000, intervalMs: 2_000 },
        );
        equal(
          cardsOfRow(appeared.value)
            .map((card) => card.id)
            .join(","),
          titleIds.join(","),
          "the curated row's titles, in order",
        );
        ctx.note(`visible after ${Math.round(appeared.elapsedMs / 1000)} s`);
        deleted = await audited(
          () =>
            content.deleteCollection({
              params: { id: collectionId },
              body: { reason: "smoke: campaign over" },
            }),
          "DELETE /editorial/collections/:id",
        );
        const gone = await ctx.eventually(
          "the deleted row gone from the home page",
          async () => {
            const { rows } = await browseAll(viewer.agent, "home");
            return rows.some((candidate) => candidate.title === name)
              ? { done: false, observed: "still listed" }
              : { done: true, value: null };
          },
          { timeoutMs: 100_000, intervalMs: 2_000 },
        );
        ctx.note(`gone after ${Math.round(gone.elapsedMs / 1000)} s`);
      } finally {
        if (!deleted) {
          await content
            .deleteCollection({ params: { id: collectionId }, body: { reason: "smoke: cleanup" } })
            .catch(() => undefined);
        }
      }
      const entries = await auditOf(admin, { targetId: collectionId });
      expectAudited(
        entries,
        [
          {
            requestId: created.requestId,
            reason: "smoke: curated row",
            what: "publishing the row",
          },
          {
            requestId: deleted.requestId,
            reason: "smoke: campaign over",
            what: "deleting the row",
          },
        ],
        actorId,
      );
    },
  },
];

/** For the experiments checks. */
export { audited, auditOf, expectAudited, staff as staffClient, subjectOf };
