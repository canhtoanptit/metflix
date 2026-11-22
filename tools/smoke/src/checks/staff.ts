/**
 * The staff API (docs/BLUEPRINT-M2.md §8.3, `/api/admin/v1`) with bearer tokens minted at the
 * development staff issuer for each role's persona: roles refused route by route, a refund
 * retried under its idempotency key refunding once, and an audit entry (found by the request id
 * the suite sent) for every action, a curated row included.
 */
import {
  ADMIN_API_BASE_PATH,
  type AdminApiClient,
  type AuditLogEntry,
  STAFF_ROLES,
  type StaffRole,
} from "@webflix/contracts";
import { check, equal, fail, problem, rejects, succeeds } from "../expect.ts";
import { capture } from "../http.ts";
import { lockedProfile } from "../limits.ts";
import { awaitMail } from "../mail.ts";
import { needs } from "../needs.ts";
import { STAFF_PERSONAS, staffTokens } from "../oidc.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { memberWithPaidInvoice } from "./billing.ts";
import { browseAll, cardsOfRow, unique } from "./util.ts";

type Persona = keyof typeof STAFF_PERSONAS;

async function staff(
  ctx: CheckContext,
  persona: Persona,
  label = persona,
): Promise<AdminApiClient> {
  const token = await ctx.env.staffToken(STAFF_PERSONAS[persona]);
  return ctx.agent(`staff-${label}`).staffApi(token);
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
      const adminToken = await ctx.env.staffToken(STAFF_PERSONAS.admin);
      problem(
        await probe.fetch(`${ADMIN_API_BASE_PATH}/plans/sync`, {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` },
          body: { reason: "smoke: no client header" },
        }),
        "csrf_check_failed",
        "a staff mutation without the client header",
      );
      // A staff token never opens a member route.
      problem(
        await probe.fetch("/api/v1/account", {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
        "unauthenticated",
        "a staff token on a member route",
      );
    },
  },
  {
    id: "staff.refund",
    area: "staff",
    title:
      "A staff refund retried under its idempotency key refunds once (the same refund answered again); other parameters or another staff member with the key conflict; each settled refund is audited",
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
      await rejects(
        () =>
          billing.refundInvoice({
            params: { accountId },
            body: { ...body, amount: { ...body.amount, amountMinor: part + 1 } },
          }),
        "staff_action_conflict",
        "the key with another amount",
      );
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
    },
  },
  {
    id: "staff.support-audit",
    area: "staff",
    title:
      "Support actions act and are audited: reading a member, removing a PIN, recording consent, sending a password reset, signing the member out everywhere",
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
      const viewer = await env.isolatedViewer("curated");
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
