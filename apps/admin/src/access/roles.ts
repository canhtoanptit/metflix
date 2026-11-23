/**
 * What each role opens, mirroring the staff API's guard (`adminRoutes[*].staffRole`; `admin`
 * passes every check). The navigation lists only the areas a role opens (the overview names the
 * others with the role each needs), and a pasted link to a screen it can't open says so and
 * calls nothing. On a screen it can open, an action it can't use is shown unavailable with the
 * role it needs (a support agent's view of billing actions), never as a control that sends a
 * request only to be refused. The server stays the authority: this is presentation, never
 * protection.
 */
import type { AdminRouteName, StaffRole } from "@webflix/contracts";

export const ROLE_LABELS: Record<StaffRole, string> = {
  support: "Support",
  billing: "Billing",
  content: "Content",
  experiments: "Experiments",
  admin: "Admin",
};

export function hasRole(roles: readonly StaffRole[], required: StaffRole): boolean {
  return roles.includes("admin") || roles.includes(required);
}

type RouteName = AdminRouteName;

/**
 * The role each staff API route needs, as `adminRoutes[*].staffRole` declares it. Copied rather
 * than imported so the console's first load carries no schema library; a unit test holds the two
 * equal, and the type makes a new route impossible to forget.
 */
export const ROUTE_ROLES = {
  getStaffSelf: "any",
  searchMembers: "support",
  getMember: "support",
  signOutMemberEverywhere: "support",
  sendMemberPasswordReset: "support",
  removeProfilePin: "support",
  getMemberPrivacy: "support",
  setMemberConsent: "support",
  cancelMemberDeletion: "support",
  refundInvoice: "billing",
  cancelMemberSubscription: "billing",
  extendMemberTrial: "billing",
  grantComplimentaryPeriod: "billing",
  listAdminPlans: "billing",
  setPlanPrice: "billing",
  syncPlans: "billing",
  getBillboard: "content",
  setBillboard: "content",
  listCollections: "content",
  createCollection: "content",
  updateCollection: "content",
  deleteCollection: "content",
  searchTitles: "content",
  listTitleAvailability: "content",
  getTitleAvailability: "content",
  setTitleAvailability: "content",
  listExperiments: "experiments",
  createExperiment: "experiments",
  getExperiment: "experiments",
  updateExperiment: "experiments",
  setExperimentStatus: "experiments",
  getExperimentResults: "experiments",
  getSystemHealth: "admin",
  listDeadLetters: "admin",
  replayDeadLetter: "admin",
  getRecommendationStatus: "admin",
  importRecommendations: "admin",
  rollbackRecommendations: "admin",
  listPendingErasures: "admin",
  confirmErasures: "admin",
  listPendingExports: "admin",
  recordExportResults: "admin",
  listAuditLog: "admin",
  listOwnAuditLog: "any",
} as const satisfies Record<RouteName, StaffRole | "any">;

export function roleFor(route: RouteName): StaffRole | "any" {
  return ROUTE_ROLES[route];
}

export function canCall(roles: readonly StaffRole[], route: RouteName): boolean {
  const required = roleFor(route);
  return required === "any" || hasRole(roles, required);
}

export interface Area {
  id: "members" | "plans" | "content" | "experiments" | "operations";
  label: string;
  role: StaffRole;
  description: string;
}

export const AREAS: readonly Area[] = [
  {
    id: "members",
    label: "Members",
    role: roleFor("searchMembers") as StaffRole,
    description: "Find a member, see how they stand, and help them.",
  },
  {
    id: "plans",
    label: "Plans & prices",
    role: roleFor("listAdminPlans") as StaffRole,
    description: "Prices per currency, and the catalogue at the payment provider.",
  },
  {
    id: "content",
    label: "Content",
    role: roleFor("listCollections") as StaffRole,
    description: "The billboard, curated rows, and when titles are available.",
  },
  {
    id: "experiments",
    label: "Experiments",
    role: roleFor("listExperiments") as StaffRole,
    description: "Define, start, pause and stop experiments; read their results.",
  },
  {
    id: "operations",
    label: "Operations",
    role: roleFor("getSystemHealth") as StaffRole,
    description: "Health, failed jobs, recommendations, privacy jobs and the audit log.",
  },
];
