import { API_BASE_PATH, type ErrorCode, isErrorCode, type OidcProvider } from "@webflix/contracts";
import {
  AppError,
  type ClientInfo,
  type IssuedSession,
  type OidcCompletion,
  sha256Hex,
  utf8Encode,
} from "@webflix/core";
import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContainer, AppEnv } from "../container.ts";
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
 * `services.identity`; cookies are set here.
 */
export function createIdentityHandlers(container: AppContainer): AreaHandlers<"identity"> {
  const { services, config } = container;
  const account = (c: AppContext) => requireAccount(container, c);
  const holder = (c: AppContext) => requireAccountHolder(container, c);
  const charge = (c: AppContext) => credentialCharge(container, c);
  /** One email to `address` (`email-send-recipient`), keyed by a digest: the limiter never holds addresses. */
  const chargeRecipient = (c: AppContext) => async (address: string) =>
    enforceRateLimit(
      container,
      c,
      "email-send-recipient",
      `recipient:${await sha256Hex(utf8Encode(address.trim().toLowerCase()))}`,
    );

  const issue = (c: AppContext, issued: IssuedSession) => {
    setKnownDeviceCookie(container, c, issued.knownDevice);
    setSessionCookie(container, c, issued.token, issued.maxAgeSec);
  };

  /**
   * The OpenID transaction cookie (§4.1): HttpOnly, `__Host-` and Secure on https, SameSite=None
   * for a form-post issuer (its callback is a cross-site POST; a Lax cookie would not arrive),
   * Lax otherwise. Plain-http development keeps Lax: the development issuer is same-site there.
   */
  const transactionCookie = (provider: OidcProvider, crossSite: boolean) => {
    const secure = config.cookies.secure;
    return {
      name: services.identity.transactionCookieName(provider, secure),
      options: {
        httpOnly: true,
        secure,
        path: "/",
        sameSite: (crossSite && secure ? "None" : "Lax") as "None" | "Lax",
      },
    };
  };

  const finishOidc = async (
    c: AppContext,
    provider: OidcProvider,
    response: {
      code?: string | undefined;
      state?: string | undefined;
      iss?: string | undefined;
      error?: string | undefined;
    },
  ) => {
    const issuer = services.identity;
    // Whatever happens next, the transaction is spent: the browser drops its cookie.
    const cookie = transactionCookie(provider, false);
    const sealed = getCookie(c, cookie.name);
    deleteCookie(c, cookie.name, { path: "/", secure: config.cookies.secure, httpOnly: true });
    const result: OidcCompletion = await issuer.completeOidc({
      provider,
      response: {
        code: response.code,
        state: response.state,
        iss: response.iss,
        error: response.error,
      },
      transaction: sealed,
      client: clientInfo(c),
    });
    if (result.session) issue(c, result.session);
    return { location: result.location };
  };

  return {
    // --- Sign-up, sign-in and the session (milestone 1) --------------------------------------
    getEmailStatus: ({ query }) => services.auth.emailStatus(query.email),

    signup: async ({ body }, c) => {
      // The schema is strict: a card (milestone 1's `payment`) never gets this far.
      const issued = await services.auth.signup(
        { email: body.email, password: body.password },
        clientInfo(c),
      );
      issue(c, issued);
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
      issue(c, issued);
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

    getSession: async ({ query }, c) => {
      const auth = await resolveAuth(container, c);
      const { state, planId, joinedAt } = await services.auth.bootstrap(auth);
      // The experiment unit: the active profile after sign-in, else the anonymous device. A
      // plan is targeted only when the account holds one (never the no-membership stand-in).
      const experiments = await services.experiments.sessionAssignments({
        profile: auth?.profile ?? null,
        deviceId: query.deviceId ?? null,
        plan: planId,
        joinedAt,
      });
      // No assignment (no running experiment, no unit): the field stays absent, as before.
      return Object.keys(experiments).length > 0 ? { ...state, experiments } : state;
    },

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
    listSignInProviders: (_request, c) => {
      // The same for every visitor and read from configuration: a shared cache may keep it.
      c.header("Cache-Control", "public, max-age=300");
      return services.identity.signInProviders();
    },

    startOidc: async ({ params, query }, c) => {
      const start = await services.identity.startOidc({
        provider: params.provider,
        intent: query.intent ?? "signin",
        returnTo: query.returnTo ?? "/",
        auth: await resolveAuth(container, c),
      });
      if (start.transaction !== null) {
        const cookie = transactionCookie(params.provider, start.crossSite);
        setCookie(c, cookie.name, start.transaction, {
          ...cookie.options,
          maxAge: start.maxAgeSec,
        });
      }
      return { location: start.location };
    },

    completeOidc: ({ params, query }, c) => finishOidc(c, params.provider, query),

    completeOidcForm: ({ params, body }, c) => finishOidc(c, params.provider, body),

    listIdentities: async (_request, c) => services.identity.listIdentities(await holder(c)),

    unlinkIdentity: async ({ params }, c) =>
      services.identity.unlinkIdentity(await holder(c), params.provider),

    getElevation: async (_request, c) => services.identity.getElevation(await account(c)),

    elevate: async ({ body }, c) => services.identity.elevate(await account(c), body.password),

    requestEmailVerification: async (_request, c) =>
      services.identity.requestEmailVerification(await account(c), chargeRecipient(c)),

    // Public: the link works in any browser. The session it was opened in, if any, decides
    // whether the account's ways in are proven too (only a session of the token's own account).
    confirmEmailVerification: async ({ body }, c) =>
      services.identity.confirmEmailVerification(body.token, await resolveAuth(container, c)),

    requestPasswordReset: ({ body }, c) =>
      services.identity.requestPasswordReset(body.email, chargeRecipient(c)),

    // Every device is signed out, then this one is signed in, as sign-in answers.
    confirmPasswordReset: async ({ body }, c) => {
      const issued = await services.identity.confirmPasswordReset(
        body.token,
        body.newPassword,
        clientInfo(c),
      );
      issue(c, issued);
      return issued.state;
    },

    receiveEmailWebhook: ({ params, body }, c) =>
      services.identity.receiveEmailWebhook(params.provider, c.req.raw.headers, body),

    getMailbox: ({ query }) => services.identity.mailbox(query),
  };
}

const OIDC_PATH = new RegExp(`^${API_BASE_PATH}/auth/oidc/([^/]+)/(start|callback)$`);

/**
 * Whether the request is a top-level browser navigation (a followed link, a typed address, a
 * form post) rather than a script or a programmatic client. Fetch Metadata says so in every
 * current browser (`Sec-Fetch-Mode: navigate`); a browser without it asks for HTML. A
 * programmatic caller (`fetch()`, the conformance suite) sends neither and keeps the problem
 * document.
 */
export function isBrowserNavigation(headers: Headers): boolean {
  const mode = headers.get("Sec-Fetch-Mode");
  if (mode !== null) return mode.toLowerCase() === "navigate";
  return (headers.get("Accept") ?? "").toLowerCase().includes("text/html");
}

/** The error code of a refused response: the thrown error, or the problem document's own. */
async function refusalCode(c: AppContext): Promise<ErrorCode> {
  if (c.error instanceof AppError) return c.error.code;
  try {
    const body = (await c.res.clone().json()) as { code?: unknown };
    if (isErrorCode(body.code)) return body.code;
  } catch {
    // Not a problem document: nothing more specific to say.
  }
  return "internal_error";
}

/**
 * The OpenID routes are browser navigations: a person must never land on a problem document.
 *
 * - The callbacks (an issuer's redirect, Apple's cross-site form post) are navigations by
 *   construction: whatever refused the request before its handler ran (validation, an oversized
 *   or mistyped form body, the `oidc` rate limit, an unavailable dependency) becomes the same
 *   redirect as every other failure, back to the transaction's `returnTo` with `?oidc=failed`
 *   (and `oidcError=rate_limited` for the rate limit), the transaction cookie dropped.
 * - The start is followed from a link, but the conformance suite and scripts call it directly:
 *   a refused start that is a browser navigation goes back to the `returnTo` it asked for (`/`
 *   when that is not a valid path) with `?oidc=failed&oidcError=<code>`; any other caller keeps
 *   the problem document.
 *
 * The refusal itself still happens (the rate limit is charged and enforced); only its rendering
 * changes.
 */
export function oidcNavigation(container: AppContainer): MiddlewareHandler<AppEnv> {
  const { services, config, logger } = container;
  return async (c, next) => {
    await next();
    const match = OIDC_PATH.exec(c.req.path);
    if (!match || c.res.status < 400) return;
    const provider = match[1] ?? "";
    const step = match[2];
    if (step === "start" && !isBrowserNavigation(c.req.raw.headers)) return;
    const code = await refusalCode(c as AppContext);
    const transactionCookie =
      step === "callback"
        ? services.identity.transactionCookieName(provider, config.cookies.secure)
        : null;
    const location =
      transactionCookie === null
        ? services.identity.refusedStartLocation(c.req.query("returnTo"), code)
        : await services.identity.abandonedCallbackLocation(
            provider,
            getCookie(c, transactionCookie),
            // Only the rate limit is worth a word: the other refusals are a failed sign-in.
            code === "rate_limited" ? code : undefined,
          );
    logger.warn(step === "start" ? "identity.oidc_start_refused" : "identity.oidc_refused", {
      provider,
      status: c.res.status,
      code,
    });
    // Replace, not merge: nothing of the problem response (its type, length, Retry-After) may
    // carry over.
    c.res = undefined;
    c.res = new Response(null, { status: 303, headers: { Location: location } });
    if (transactionCookie !== null) {
      deleteCookie(c, transactionCookie, {
        path: "/",
        secure: config.cookies.secure,
        httpOnly: true,
      });
    }
  };
}
