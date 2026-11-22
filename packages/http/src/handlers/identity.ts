import { type ClientInfo, sha256Hex, utf8Encode } from "@webflix/core";
import type { AppContainer } from "../container.ts";
import { notImplemented } from "../routing.ts";
import {
  clearSessionCookie,
  credentialCharge,
  enforceRateLimit,
  knownDeviceCookie,
  requireAccount,
  requireAccountHolder,
  resolveAuth,
  setKnownDeviceCookie,
  setSessionCookie,
} from "../session.ts";
import type { AppContext, AreaHandlers } from "./types.ts";

function clientInfo(c: AppContext): ClientInfo {
  return { userAgent: c.req.header("User-Agent") ?? null };
}

/**
 * The identity area's routes: sign-up, sign-in and the session, devices, account details and
 * profiles (milestone 1), and milestone 2's federated sign-in, linked identities, account-holder
 * proof, email verification, password reset, the email webhook and the local mailbox. Each is a
 * thin mapping onto `services.auth`, `services.account`, `services.profiles` and
 * `services.identity`; `notImplemented()` until the identity area implements it.
 */
export function createIdentityHandlers(container: AppContainer): AreaHandlers<"identity"> {
  const { services } = container;
  const account = (c: AppContext) => requireAccount(container, c);
  const holder = (c: AppContext) => requireAccountHolder(container, c);
  const charge = (c: AppContext) => credentialCharge(container, c);

  return {
    // --- Sign-up, sign-in and the session (milestone 1) --------------------------------------
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

    // --- Account details and devices (milestone 1) -------------------------------------------
    updateAccount: async ({ body }, c) =>
      services.account.updateAccount(await holder(c), body, charge(c)),

    listDevices: async (_request, c) => services.account.listDevices(await holder(c)),

    revokeDevice: async ({ params }, c) => {
      const auth = await holder(c);
      await services.account.revokeDevice(auth, params.id);
      // Revoking this very device is a sign-out.
      if (params.id === auth.session.id) clearSessionCookie(container, c);
    },

    // --- Profiles (milestone 1) ---------------------------------------------------------------
    listProfiles: async (_request, c) =>
      services.profiles.list((await account(c)).session.accountId),

    createProfile: async ({ body }, c) =>
      services.profiles.create(await account(c), body, charge(c)),

    updateProfile: async ({ params, body }, c) =>
      services.profiles.update(await account(c), params.id, body, charge(c)),

    deleteProfile: async ({ params, body }, c) =>
      services.profiles.remove(await account(c), params.id, body ?? {}, charge(c)),

    listAvatars: () => services.profiles.listAvatars(),

    // --- Milestone 2 (§4, §8.2) ----------------------------------------------------------------
    startOidc: notImplemented(),
    completeOidc: notImplemented(),
    completeOidcForm: notImplemented(),
    listIdentities: notImplemented(),
    unlinkIdentity: notImplemented(),
    getElevation: notImplemented(),
    elevate: notImplemented(),
    requestEmailVerification: notImplemented(),
    confirmEmailVerification: notImplemented(),
    requestPasswordReset: notImplemented(),
    confirmPasswordReset: notImplemented(),
    receiveEmailWebhook: notImplemented(),
    getMailbox: notImplemented(),
  };
}
