import type { routes } from "@webflix/contracts";
import { type ClientInfo, PLAN_CATALOG, sha256Hex, utf8Encode } from "@webflix/core";
import type { Context } from "hono";
import type { AppContainer, AppEnv } from "./container.ts";
import type { RouteHandlers } from "./routing.ts";
import {
  clearSessionCookie,
  credentialCharge,
  enforceRateLimit,
  knownDeviceCookie,
  requireAccount,
  requireAccountHolder,
  requireViewer,
  resolveAuth,
  setKnownDeviceCookie,
  setSessionCookie,
} from "./session.ts";

/**
 * The showcase is the same for everyone and changes only with the catalog: browsers and shared
 * caches keep it for five minutes and may serve it stale for a day while revalidating with its
 * ETag (a 304 is a few bytes).
 */
const SHOWCASE_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400";

function clientInfo(c: Context): ClientInfo {
  return { userAgent: c.req.header("User-Agent") ?? null };
}

/**
 * One handler per route of the contract. Each is a thin mapping from validated input to a
 * service call; authentication, CSRF, rate limits, validation and error mapping happen
 * around them (guard, `bindRoutes`, problem handler).
 */
export function createHandlers(container: AppContainer): RouteHandlers<typeof routes, AppEnv> {
  const { services } = container;
  const account = (c: Context<AppEnv>) => requireAccount(container, c);
  const holder = (c: Context<AppEnv>) => requireAccountHolder(container, c);
  const charge = (c: Context<AppEnv>) => credentialCharge(container, c);
  const viewer = (c: Context<AppEnv>) => requireViewer(container, c);

  return {
    // --- Auth & session ---------------------------------------------------------------------
    getEmailStatus: ({ query }) => services.auth.emailStatus(query.email),

    signup: async ({ body }, c) => {
      const issued = await services.auth.signup(body, clientInfo(c));
      setKnownDeviceCookie(container, c, issued.knownDevice);
      setSessionCookie(container, c, issued.token, issued.maxAgeSec);
      return issued.state;
    },

    login: async ({ body }, c) => {
      const issued = await services.auth.login(body, clientInfo(c), {
        knownDevice: knownDeviceCookie(container, c),
        // Keyed by a digest of the address: the limiter's store never holds emails.
        chargeEmail: async () =>
          enforceRateLimit(
            container,
            c,
            "auth-email",
            `email:${await sha256Hex(utf8Encode(body.email))}`,
          ),
      });
      setKnownDeviceCookie(container, c, issued.knownDevice);
      setSessionCookie(container, c, issued.token, issued.maxAgeSec);
      return issued.state;
    },

    logout: async (_request, c) => {
      await services.auth.logout(await resolveAuth(container, c));
      clearSessionCookie(container, c);
    },

    logoutAll: async (_request, c) => {
      await services.auth.logoutAll(await holder(c));
      clearSessionCookie(container, c);
    },

    getSession: async (_request, c) => services.auth.getSession(await resolveAuth(container, c)),

    selectProfile: async ({ body }, c) =>
      services.auth.selectProfile(await account(c), body, charge(c)),

    clearProfile: async (_request, c) => services.auth.clearProfile(await account(c)),

    // --- Account ------------------------------------------------------------------------------
    getAccount: async (_request, c) =>
      services.account.getAccount((await holder(c)).session.accountId),

    updateAccount: async ({ body }, c) =>
      services.account.updateAccount(await holder(c), body, charge(c)),

    listPlans: () => ({ items: [...PLAN_CATALOG] }),

    changePlan: async ({ body }, c) => {
      const auth = await holder(c);
      // A card sent with a plan change is verified like any other: same budget.
      if (body.payment) await enforceRateLimit(container, c, "payment");
      return services.account.changePlan(auth.session.accountId, body);
    },

    updatePaymentMethod: async ({ body }, c) =>
      services.account.updatePaymentMethod((await holder(c)).session.accountId, body.payment),

    cancelMembership: async (_request, c) =>
      services.account.cancel((await holder(c)).session.accountId),

    resumeMembership: async (_request, c) =>
      services.account.resume((await holder(c)).session.accountId),

    listDevices: async (_request, c) => services.account.listDevices(await holder(c)),

    revokeDevice: async ({ params }, c) => {
      const auth = await holder(c);
      await services.account.revokeDevice(auth, params.id);
      // Revoking this very device is a sign-out.
      if (params.id === auth.session.id) clearSessionCookie(container, c);
    },

    // --- Profiles -----------------------------------------------------------------------------
    listProfiles: async (_request, c) =>
      services.profiles.list((await account(c)).session.accountId),

    createProfile: async ({ body }, c) =>
      services.profiles.create(await account(c), body, charge(c)),

    updateProfile: async ({ params, body }, c) =>
      services.profiles.update(await account(c), params.id, body, charge(c)),

    deleteProfile: async ({ params, body }, c) =>
      services.profiles.remove(await account(c), params.id, body ?? {}, charge(c)),

    listAvatars: () => services.profiles.listAvatars(),

    // --- Browse -------------------------------------------------------------------------------
    getBrowse: async ({ query }, c) =>
      services.browse.getBrowse(await viewer(c), query.view ?? "home", query.cursor),

    getBrowseRow: async ({ params, query }, c) =>
      services.browse.getRow(await viewer(c), params.rowId, query.cursor, query.limit),

    listGenres: async (_request, c) => services.browse.listGenres(await viewer(c)),

    getGenreBrowse: async ({ params, query }, c) =>
      services.browse.getGenrePage(await viewer(c), params.slug, query),

    // --- Titles -------------------------------------------------------------------------------
    getShowcase: async (_request, c) => {
      const { showcase, etag } = await services.browse.getShowcase();
      c.header("Cache-Control", SHOWCASE_CACHE_CONTROL);
      c.header("ETag", etag);
      return showcase;
    },

    getTitle: async ({ params }, c) => services.browse.getTitle(await viewer(c), params.id),

    getTitlePopularity: ({ params }) => services.browse.getTitlePopularity(params.id),

    listEpisodes: async ({ params }, c) =>
      services.browse.listEpisodes(await viewer(c), params.id, params.seasonNumber),

    listSimilar: async ({ params }, c) => services.browse.listSimilar(await viewer(c), params.id),

    search: async ({ query }, c) => services.search.search(await viewer(c), query),

    // --- Library ------------------------------------------------------------------------------
    getMyList: async ({ query }, c) =>
      services.library.getMyList(await viewer(c), query.cursor, query.limit),

    addToMyList: async ({ params }, c) =>
      services.library.addToMyList(await viewer(c), params.titleId),

    removeFromMyList: async ({ params }, c) =>
      services.library.removeFromMyList(await viewer(c), params.titleId),

    rateTitle: async ({ params, body }, c) =>
      services.library.rate(await viewer(c), params.titleId, body.value),

    clearRating: async ({ params }, c) =>
      services.library.clearRating(await viewer(c), params.titleId),

    getContinueWatching: async (_request, c) => services.library.continueWatching(await viewer(c)),

    removeFromContinueWatching: async ({ params }, c) =>
      services.library.removeFromContinueWatching(await viewer(c), params.titleId),

    getHistory: async ({ query }, c) =>
      services.library.history(await viewer(c), query.cursor, query.limit),

    removeHistoryEntry: async ({ params }, c) =>
      services.library.removeHistoryEntry(await viewer(c), params.id),

    // --- Notifications ------------------------------------------------------------------------
    listNotifications: async (_request, c) => services.library.notifications(await viewer(c)),

    markNotificationsRead: async ({ body }, c) =>
      services.library.markNotificationsRead(await viewer(c), body.ids),

    // --- Playback -----------------------------------------------------------------------------
    createPlaybackSession: async ({ body }, c) => services.playback.start(await viewer(c), body),

    sendHeartbeat: async ({ params, body }, c) =>
      services.playback.heartbeat(await viewer(c), params.id, body),

    endPlaybackSession: async ({ params, body }, c) =>
      services.playback.end(await viewer(c), params.id, body),
  };
}
