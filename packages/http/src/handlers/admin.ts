import type { AppContainer } from "../container.ts";
import { notImplemented } from "../routing.ts";
import { requireStaff } from "../session.ts";
import type { AdminHandlers } from "./types.ts";

/**
 * The staff API (milestone 2 §8.3, `adminRoutes`): thin handlers over the services of the area
 * that owns the data (billing refunds, identity support actions, personalisation's editorial
 * data, experiments), each writing the audit log through that area's repository in the same
 * batch as its change. The guard has already verified the bearer token and the role.
 */
export function createAdminHandlers(container: AppContainer): AdminHandlers {
  return {
    getStaffSelf: async (_request, c) => {
      const staff = await requireStaff(container, c);
      return { subject: staff.subject, name: staff.name, email: staff.email, roles: staff.roles };
    },
    searchMembers: notImplemented(),
    getMember: notImplemented(),
    signOutMemberEverywhere: notImplemented(),
    sendMemberPasswordReset: notImplemented(),
    removeProfilePin: notImplemented(),
    refundInvoice: notImplemented(),
    cancelMemberSubscription: notImplemented(),
    extendMemberTrial: notImplemented(),
    grantComplimentaryPeriod: notImplemented(),
    listAdminPlans: notImplemented(),
    setPlanPrice: notImplemented(),
    syncPlans: notImplemented(),
    getBillboard: notImplemented(),
    setBillboard: notImplemented(),
    listCollections: notImplemented(),
    createCollection: notImplemented(),
    updateCollection: notImplemented(),
    deleteCollection: notImplemented(),
    setTitleAvailability: notImplemented(),
    listExperiments: notImplemented(),
    createExperiment: notImplemented(),
    getExperiment: notImplemented(),
    updateExperiment: notImplemented(),
    setExperimentStatus: notImplemented(),
    getExperimentResults: notImplemented(),
    getSystemHealth: notImplemented(),
    listDeadLetters: notImplemented(),
    replayDeadLetter: notImplemented(),
    getRecommendationStatus: notImplemented(),
    importRecommendations: notImplemented(),
    listAuditLog: notImplemented(),
  };
}
