import type { StaffContext } from "@webflix/core";
import type { AppContainer } from "../container.ts";
import { requireStaff } from "../session.ts";
import type { AdminHandlers, AppContext } from "./types.ts";

/**
 * The staff API (milestone 2 §8.3, `adminRoutes`): thin handlers over the admin area's staff
 * operations (`services.admin`), which call the service of the area that owns the data and keep
 * the audit log. The guard has already verified the bearer token and the route's role (from the
 * route table) and the client header on mutations; validation has run. Nothing here reads the
 * member session cookie: a staff identity never becomes a member session, and a member session
 * never opens these routes.
 */
export function createAdminHandlers(container: AppContainer): AdminHandlers {
  const admin = container.services.admin;

  /** Who acts (the verified token, memoised per request by the guard) and the request id. */
  async function staff(c: AppContext): Promise<StaffContext> {
    const identity = await requireStaff(container, c);
    return {
      staff: { subject: identity.subject, name: identity.name, email: identity.email },
      requestId: c.get("requestId") ?? null,
    };
  }

  return {
    getStaffSelf: async (_request, c) => {
      const identity = await requireStaff(container, c);
      return {
        subject: identity.subject,
        name: identity.name,
        email: identity.email,
        roles: identity.roles,
      };
    },

    // --- Members --------------------------------------------------------------------------
    searchMembers: async ({ query }, c) => admin.members.search(await staff(c), query),
    getMember: async ({ params }, c) => admin.members.get(await staff(c), params.accountId),
    signOutMemberEverywhere: async ({ params, body }, c) => {
      await admin.members.signOutEverywhere(await staff(c), params.accountId, body.reason);
    },
    sendMemberPasswordReset: async ({ params, body }, c) => {
      await admin.members.sendPasswordReset(await staff(c), params.accountId, body.reason);
    },
    removeProfilePin: async ({ params, body }, c) => {
      await admin.members.removeProfilePin(
        await staff(c),
        params.accountId,
        params.profileId,
        body.reason,
      );
    },

    // --- Member privacy -------------------------------------------------------------------
    getMemberPrivacy: async ({ params }, c) => admin.privacy.get(await staff(c), params.accountId),
    setMemberConsent: async ({ params, body }, c) =>
      admin.privacy.setConsent(await staff(c), params.accountId, body),
    cancelMemberDeletion: async ({ params, body }, c) => {
      await admin.privacy.cancelDeletion(await staff(c), params.accountId, body.reason);
    },

    // --- Billing actions ------------------------------------------------------------------
    refundInvoice: async ({ params, body }, c) =>
      admin.billing.refund(await staff(c), params.accountId, body),
    cancelMemberSubscription: async ({ params, body }, c) =>
      admin.billing.cancel(await staff(c), params.accountId, body),
    extendMemberTrial: async ({ params, body }, c) =>
      admin.billing.extendTrial(await staff(c), params.accountId, body),
    grantComplimentaryPeriod: async ({ params, body }, c) =>
      admin.billing.grantComplimentaryPeriod(await staff(c), params.accountId, body),

    // --- Plans and prices -----------------------------------------------------------------
    listAdminPlans: () => admin.billing.listPlans(),
    setPlanPrice: async ({ params, body }, c) =>
      admin.billing.setPlanPrice(await staff(c), {
        planId: params.planId,
        currency: params.currency,
        amountMinor: body.amountMinor,
        reason: body.reason,
      }),
    syncPlans: async ({ body }, c) => admin.billing.syncPlans(await staff(c), body.reason),

    // --- Editorial ------------------------------------------------------------------------
    getBillboard: ({ params }) => admin.editorial.getBillboard(params.view),
    setBillboard: async ({ params, body }, c) =>
      admin.editorial.setBillboard(await staff(c), params.view, body.titleIds, body.reason),
    listCollections: () => admin.editorial.listCollections(),
    createCollection: async ({ body }, c) => {
      const { reason, ...design } = body;
      return admin.editorial.createCollection(await staff(c), design, reason);
    },
    updateCollection: async ({ params, body }, c) => {
      const { reason, ...design } = body;
      return admin.editorial.updateCollection(await staff(c), params.id, design, reason);
    },
    deleteCollection: async ({ params, body }, c) => {
      await admin.editorial.deleteCollection(await staff(c), params.id, body.reason);
    },
    setTitleAvailability: async ({ params, body }, c) => {
      const { reason, ...change } = body;
      return admin.editorial.setTitleAvailability(await staff(c), params.titleId, change, reason);
    },

    // --- Experiments ----------------------------------------------------------------------
    listExperiments: () => admin.experiments.list(),
    createExperiment: async ({ body }, c) => {
      const { reason, ...design } = body;
      return admin.experiments.create(await staff(c), design, reason);
    },
    getExperiment: ({ params }) => admin.experiments.get(params.key),
    updateExperiment: async ({ params, body }, c) => {
      const { reason, ...changes } = body;
      return admin.experiments.update(await staff(c), params.key, changes, reason);
    },
    setExperimentStatus: async ({ params, body }, c) =>
      admin.experiments.setStatus(await staff(c), params.key, body.status, body.reason),
    getExperimentResults: ({ params }) => admin.experiments.results(params.key),

    // --- System ---------------------------------------------------------------------------
    getSystemHealth: () => admin.system.health(),
    listDeadLetters: ({ query }) => admin.system.deadLetters(query),
    replayDeadLetter: async ({ params, body }, c) =>
      admin.system.replayDeadLetter(await staff(c), params.id, body.reason),
    getRecommendationStatus: () => admin.system.recommendations(),
    importRecommendations: async ({ body }, c) =>
      admin.system.importRecommendations(await staff(c), body.reason),
    rollbackRecommendations: async ({ body }, c) =>
      admin.system.rollbackRecommendations(await staff(c), body.reason),
    listPendingErasures: ({ query }) => admin.privacy.pendingErasures(query.limit ?? 100),
    confirmErasures: async ({ body }, c) => {
      await admin.privacy.confirmErasures(await staff(c), body.subjectKeys, body.reason);
    },

    listAuditLog: ({ query }) => admin.audit.list(query),
  };
}
