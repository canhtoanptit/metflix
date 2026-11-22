// GENERATED from src/routes.ts and src/admin-routes.ts by scripts/generate-route-index.mjs.
// Do not edit. Run `pnpm --filter @webflix/contracts generate` after changing a route table.
import type { AdminRoutes } from "./admin-routes.ts";
import type { ClientRoutes, NavigationRoutes } from "./route.ts";
import type { Routes } from "./routes.ts";

type MemberClientRoutes = ClientRoutes<Routes>;
type MemberNavigationRoutes = NavigationRoutes<Routes>;
type AdminClientRoutes = ClientRoutes<AdminRoutes>;

/**
 * Method and path per client route of the member API: the zod-free runtime table behind
 * `createApiClient`.
 * The `satisfies` clause makes a stale entry a type error.
 */
export const ROUTE_INDEX = {
  getEmailStatus: { method: "GET", path: "/auth/email-status" },
  signup: { method: "POST", path: "/auth/signup" },
  login: { method: "POST", path: "/auth/login" },
  logout: { method: "POST", path: "/auth/logout" },
  logoutAll: { method: "POST", path: "/auth/logout-all" },
  getSession: { method: "GET", path: "/session" },
  selectProfile: { method: "PUT", path: "/session/profile" },
  clearProfile: { method: "DELETE", path: "/session/profile" },
  updateAccount: { method: "PATCH", path: "/account" },
  listDevices: { method: "GET", path: "/account/sessions" },
  revokeDevice: { method: "DELETE", path: "/account/sessions/:id" },
  listProfiles: { method: "GET", path: "/profiles" },
  createProfile: { method: "POST", path: "/profiles" },
  updateProfile: { method: "PATCH", path: "/profiles/:id" },
  deleteProfile: { method: "DELETE", path: "/profiles/:id" },
  listAvatars: { method: "GET", path: "/avatars" },
  listIdentities: { method: "GET", path: "/account/identities" },
  unlinkIdentity: { method: "DELETE", path: "/account/identities/:provider" },
  getElevation: { method: "GET", path: "/session/elevation" },
  elevate: { method: "POST", path: "/session/elevation" },
  requestEmailVerification: { method: "POST", path: "/auth/email-verification" },
  confirmEmailVerification: { method: "POST", path: "/auth/email-verification/confirm" },
  requestPasswordReset: { method: "POST", path: "/auth/password-reset" },
  confirmPasswordReset: { method: "POST", path: "/auth/password-reset/confirm" },
  getMailbox: { method: "GET", path: "/diagnostics/mailbox" },
  getAccount: { method: "GET", path: "/account" },
  listPlans: { method: "GET", path: "/plans" },
  changePlan: { method: "PUT", path: "/account/subscription" },
  updatePaymentMethod: { method: "PUT", path: "/account/payment-method" },
  cancelMembership: { method: "DELETE", path: "/account/subscription" },
  resumeMembership: { method: "POST", path: "/account/subscription/resume" },
  getBillingConfig: { method: "GET", path: "/billing/config" },
  startCheckout: { method: "POST", path: "/billing/checkout" },
  getCheckout: { method: "GET", path: "/billing/checkout/:id" },
  confirmCheckout: { method: "POST", path: "/billing/checkout/:id/confirm" },
  previewPlanChange: { method: "POST", path: "/billing/subscription/preview" },
  setupPaymentMethod: { method: "POST", path: "/billing/payment-method/setup" },
  getPaymentMethodSetup: { method: "GET", path: "/billing/payment-method/setup/:id" },
  listInvoices: { method: "GET", path: "/billing/invoices" },
  validatePromotion: { method: "POST", path: "/billing/promotions/validate" },
  advanceBillingClock: { method: "POST", path: "/diagnostics/billing/clock" },
  getBrowse: { method: "GET", path: "/browse" },
  getBrowseRow: { method: "GET", path: "/browse/rows/:rowId" },
  listGenres: { method: "GET", path: "/genres" },
  getGenreBrowse: { method: "GET", path: "/browse/genre/:slug" },
  getShowcase: { method: "GET", path: "/showcase" },
  getTitle: { method: "GET", path: "/titles/:id" },
  listEpisodes: { method: "GET", path: "/titles/:id/seasons/:seasonNumber/episodes" },
  getTitlePopularity: { method: "GET", path: "/titles/:id/popularity" },
  listSimilar: { method: "GET", path: "/titles/:id/similar" },
  search: { method: "GET", path: "/search" },
  getMyList: { method: "GET", path: "/my-list" },
  addToMyList: { method: "PUT", path: "/my-list/:titleId" },
  removeFromMyList: { method: "DELETE", path: "/my-list/:titleId" },
  rateTitle: { method: "PUT", path: "/ratings/:titleId" },
  clearRating: { method: "DELETE", path: "/ratings/:titleId" },
  getContinueWatching: { method: "GET", path: "/continue-watching" },
  removeFromContinueWatching: { method: "DELETE", path: "/continue-watching/:titleId" },
  getHistory: { method: "GET", path: "/history" },
  removeHistoryEntry: { method: "DELETE", path: "/history/:id" },
  listNotifications: { method: "GET", path: "/notifications" },
  markNotificationsRead: { method: "POST", path: "/notifications/read" },
  createPlaybackSession: { method: "POST", path: "/playback/sessions" },
  sendHeartbeat: { method: "POST", path: "/playback/sessions/:id/heartbeat" },
  endPlaybackSession: { method: "DELETE", path: "/playback/sessions/:id" },
  ingestEvents: { method: "POST", path: "/events" },
  getConsent: { method: "GET", path: "/privacy/consent" },
  updateConsent: { method: "PUT", path: "/privacy/consent" },
  requestDataExport: { method: "POST", path: "/privacy/export" },
  listPrivacyRequests: { method: "GET", path: "/privacy/requests" },
  requestAccountDeletion: { method: "POST", path: "/account/deletion" },
  cancelAccountDeletion: { method: "DELETE", path: "/account/deletion" },
  getRecentEvents: { method: "GET", path: "/diagnostics/events" },
} as const satisfies {
  readonly [K in keyof MemberClientRoutes]: {
    method: MemberClientRoutes[K]["method"];
    path: MemberClientRoutes[K]["path"];
  };
};

/**
 * Redirect routes the browser navigates to (`navigationUrl`).
 * The `satisfies` clause makes a stale entry a type error.
 */
export const NAVIGATION_ROUTE_INDEX = {
  startOidc: { method: "GET", path: "/auth/oidc/:provider/start" },
  completeOidc: { method: "GET", path: "/auth/oidc/:provider/callback" },
} as const satisfies {
  readonly [K in keyof MemberNavigationRoutes]: {
    method: MemberNavigationRoutes[K]["method"];
    path: MemberNavigationRoutes[K]["path"];
  };
};

/**
 * Method and path per route of the staff API: the runtime table behind `createAdminApiClient`.
 * The `satisfies` clause makes a stale entry a type error.
 */
export const ADMIN_ROUTE_INDEX = {
  getStaffSelf: { method: "GET", path: "/me" },
  searchMembers: { method: "GET", path: "/members" },
  getMember: { method: "GET", path: "/members/:accountId" },
  signOutMemberEverywhere: { method: "POST", path: "/members/:accountId/sign-out" },
  sendMemberPasswordReset: { method: "POST", path: "/members/:accountId/password-reset" },
  removeProfilePin: { method: "DELETE", path: "/members/:accountId/profiles/:profileId/pin" },
  refundInvoice: { method: "POST", path: "/members/:accountId/refunds" },
  cancelMemberSubscription: { method: "POST", path: "/members/:accountId/subscription/cancel" },
  extendMemberTrial: { method: "POST", path: "/members/:accountId/subscription/extend-trial" },
  grantComplimentaryPeriod: {
    method: "POST",
    path: "/members/:accountId/subscription/complimentary",
  },
  listAdminPlans: { method: "GET", path: "/plans" },
  setPlanPrice: { method: "PUT", path: "/plans/:planId/prices/:currency" },
  syncPlans: { method: "POST", path: "/plans/sync" },
  getBillboard: { method: "GET", path: "/editorial/billboards/:view" },
  setBillboard: { method: "PUT", path: "/editorial/billboards/:view" },
  listCollections: { method: "GET", path: "/editorial/collections" },
  createCollection: { method: "POST", path: "/editorial/collections" },
  updateCollection: { method: "PUT", path: "/editorial/collections/:id" },
  deleteCollection: { method: "DELETE", path: "/editorial/collections/:id" },
  setTitleAvailability: { method: "PUT", path: "/titles/:titleId/availability" },
  listExperiments: { method: "GET", path: "/experiments" },
  createExperiment: { method: "POST", path: "/experiments" },
  getExperiment: { method: "GET", path: "/experiments/:key" },
  updateExperiment: { method: "PATCH", path: "/experiments/:key" },
  setExperimentStatus: { method: "PUT", path: "/experiments/:key/status" },
  getExperimentResults: { method: "GET", path: "/experiments/:key/results" },
  getSystemHealth: { method: "GET", path: "/system/health" },
  listDeadLetters: { method: "GET", path: "/system/dead-letters" },
  replayDeadLetter: { method: "POST", path: "/system/dead-letters/:id/replay" },
  getRecommendationStatus: { method: "GET", path: "/system/recommendations" },
  importRecommendations: { method: "POST", path: "/system/recommendations/import" },
  listAuditLog: { method: "GET", path: "/audit" },
} as const satisfies {
  readonly [K in keyof AdminClientRoutes]: {
    method: AdminClientRoutes[K]["method"];
    path: AdminClientRoutes[K]["path"];
  };
};
