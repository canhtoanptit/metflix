/**
 * RP-Initiated Logout 1.0. With a valid `id_token_hint` the session ends at once; without one
 * the user confirms on a page (a cross-site link alone must not sign anyone out). Redirects only
 * to a `post_logout_redirect_uri` registered, exactly, for the client the request identifies.
 */
import type { NormalizedClient } from "../config.ts";
import { endpoint, type IssuerContext, log, nowSec, revocationTtlMs } from "../context.ts";
import { randomToken, timingSafeEqual } from "../encoding.ts";
import {
  duplicateParameter,
  methodNotAllowed,
  page,
  param,
  readCookie,
  readForm,
  redirect,
  serializeCookie,
} from "../http.ts";
import { newNonce, pageCsp, renderError, renderLogoutConfirm, renderSignedOut } from "../pages.ts";
import { sessionEndedKey, verifyOwnJwt } from "../tokens.ts";
import { readSession } from "./authorize.ts";

function errorPage(status: number, title: string, message: string): Response {
  const nonce = newNonce();
  return page({ status, body: renderError(nonce, title, message), csp: pageCsp(nonce, []) });
}

interface LogoutTarget {
  redirectUri: string | null;
  state: string | null;
}

async function endSession(context: IssuerContext, request: Request): Promise<string> {
  const session = await readSession(context, request);
  if (session && context.store) {
    await context.store.claim(
      sessionEndedKey(context, session.sid),
      context.clock.now() + revocationTtlMs(context),
    );
  }
  if (session) log(context, "info", "session ended", {});
  return serializeCookie(context.cookies.session, "", {
    path: context.cookies.path,
    secure: context.cookies.secure,
    sameSite: "Lax",
    maxAge: 0,
  });
}

function finish(target: LogoutTarget, cookie: string, method: string): Response {
  if (target.redirectUri !== null) {
    const url = new URL(target.redirectUri);
    if (target.state !== null) url.searchParams.append("state", target.state);
    return redirect(url.href, method === "POST" ? 303 : 302, [cookie]);
  }
  const nonce = newNonce();
  return page({ body: renderSignedOut(nonce), csp: pageCsp(nonce, []), cookies: [cookie] });
}

function audiences(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function confirm(
  context: IssuerContext,
  request: Request,
  params: URLSearchParams,
): Promise<Response> {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin") {
    return errorPage(403, "Request refused", "Sign out from this issuer's own page.");
  }
  const payload = await context.sealer.unseal("logout", param(params, "txn") ?? "");
  const cookie = readCookie(request, context.cookies.csrf);
  if (!payload || typeof payload.x !== "string") {
    return errorPage(400, "This page has expired", "Return to the application and sign out again.");
  }
  if (!cookie || !(await timingSafeEqual(cookie, payload.x))) {
    return errorPage(403, "Request refused", "Sign out from the page this browser received.");
  }
  const target: LogoutTarget = {
    redirectUri: typeof payload.r === "string" ? payload.r : null,
    state: typeof payload.st === "string" ? payload.st : null,
  };
  return finish(target, await endSession(context, request), "POST");
}

export async function handleLogout(context: IssuerContext, request: Request): Promise<Response> {
  let params: URLSearchParams;
  if (request.method === "GET") {
    params = new URL(request.url).searchParams;
  } else if (request.method === "POST") {
    const form = await readForm(request);
    if (!form.ok)
      return errorPage(400, "Invalid sign-out request", "The request body could not be read.");
    params = form.params;
    if (params.has("txn")) return confirm(context, request, params);
  } else {
    return methodNotAllowed(["GET", "POST"]);
  }
  const duplicate = duplicateParameter(params);
  if (duplicate !== undefined) {
    return errorPage(400, "Invalid sign-out request", `The request repeats ${duplicate}.`);
  }

  let client: NormalizedClient | undefined;
  const hint = param(params, "id_token_hint");
  let hintSid: string | null = null;
  if (hint !== undefined) {
    const verified = await verifyOwnJwt(context, hint, { allowExpired: true });
    if (!verified.ok) {
      return errorPage(
        400,
        "Invalid sign-out request",
        "id_token_hint is not an ID token from this issuer.",
      );
    }
    hintSid = typeof verified.claims.sid === "string" ? verified.claims.sid : null;
    client = audiences(verified.claims.aud)
      .map((id) => context.clients.get(id))
      .find((candidate) => candidate !== undefined);
  }
  const clientId = param(params, "client_id");
  if (clientId !== undefined) {
    const named = context.clients.get(clientId);
    if (!named || (client !== undefined && client !== named)) {
      return errorPage(400, "Invalid sign-out request", "client_id does not match the ID token.");
    }
    client = named;
  }
  const redirectUri = param(params, "post_logout_redirect_uri") ?? null;
  if (redirectUri !== null && !client?.postLogoutRedirectUris.includes(redirectUri)) {
    return errorPage(
      400,
      "Sign-out address not registered",
      "The application asked to return to an address it did not register for signing out.",
    );
  }
  const target: LogoutTarget = { redirectUri, state: param(params, "state") ?? null };
  const session = await readSession(context, request);
  // Without confirmation only when the hint was issued for this very session: any valid ID token
  // (an attacker's own, say) must not sign someone else out from a cross-site link.
  if (!session || (hintSid !== null && hintSid === session.sid)) {
    return finish(target, await endSession(context, request), request.method);
  }

  // No proof the request comes from the application the user is signed in to: ask.
  const existing = readCookie(request, context.cookies.csrf);
  const csrf = existing && /^[A-Za-z0-9_-]{22,64}$/.test(existing) ? existing : randomToken(24);
  const transaction = await context.sealer.seal("logout", {
    exp: nowSec(context) + context.lifetimes.transactionSec,
    r: target.redirectUri,
    st: target.state,
    x: csrf,
  });
  const nonce = newNonce();
  const action = endpoint(context, "/logout");
  const formAction = [context.issuerUrl.origin];
  if (redirectUri !== null) formAction.push(new URL(redirectUri).origin);
  return page({
    body: renderLogoutConfirm(nonce, action, transaction),
    csp: pageCsp(nonce, formAction),
    cookies:
      existing === csrf
        ? []
        : [
            serializeCookie(context.cookies.csrf, csrf, {
              path: context.cookies.path,
              secure: context.cookies.secure,
              sameSite: "Lax",
              maxAge: context.lifetimes.sessionSec,
            }),
          ],
  });
}
