// GENERATED from src/routes.ts by scripts/generate-route-index.mjs. Do not edit.
// Run `pnpm --filter @webflix/contracts generate` after changing the route table.
import type { Routes } from "./routes.ts";

/**
 * Method and path per route: the zod-free runtime table behind `createApiClient`.
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
  getAccount: { method: "GET", path: "/account" },
  updateAccount: { method: "PATCH", path: "/account" },
  listPlans: { method: "GET", path: "/plans" },
  changePlan: { method: "PUT", path: "/account/subscription" },
  updatePaymentMethod: { method: "PUT", path: "/account/payment-method" },
  cancelMembership: { method: "DELETE", path: "/account/subscription" },
  resumeMembership: { method: "POST", path: "/account/subscription/resume" },
  listDevices: { method: "GET", path: "/account/sessions" },
  revokeDevice: { method: "DELETE", path: "/account/sessions/:id" },
  listProfiles: { method: "GET", path: "/profiles" },
  createProfile: { method: "POST", path: "/profiles" },
  updateProfile: { method: "PATCH", path: "/profiles/:id" },
  deleteProfile: { method: "DELETE", path: "/profiles/:id" },
  listAvatars: { method: "GET", path: "/avatars" },
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
} as const satisfies {
  readonly [K in keyof Routes]: { method: Routes[K]["method"]; path: Routes[K]["path"] };
};
