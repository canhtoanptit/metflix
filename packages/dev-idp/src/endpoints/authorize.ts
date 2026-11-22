/**
 * The authorisation endpoint (OpenID Connect Core §3.1.2) and the sign-in page behind it.
 *
 * Nothing is stored between the request and the page's answer: the validated request travels in
 * a sealed transaction inside the page, bound to the browser by a CSRF cookie.
 */
import { isValidEmail } from "../config.ts";
import { endpoint, type IssuerContext, log, nowSec, storeKey } from "../context.ts";
import { base64UrlEncode, randomToken, sha256, timingSafeEqual } from "../encoding.ts";
import {
  type DevIdpFaults,
  FAULT_CATALOGUE,
  mergeFaults,
  parseFlowFaults,
  serializeFlowFaults,
} from "../faults.ts";
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
import {
  newNonce,
  type PickerPersona,
  pageCsp,
  renderError,
  renderFormPost,
  renderPicker,
} from "../pages.ts";
import { type PersonaRef, personaName, STAFF_ROLE_CLIENT } from "../personas.ts";
import { grantIdentity, sessionEndedKey } from "../tokens.ts";

const PROMPTS = new Set(["none", "login", "consent", "select_account"]);
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
// Sized so the sealed sign-in transaction always fits (seal.ts) whatever the values hold.
const MAX_STATE = 1024;
const MAX_NONCE = 512;
const MAX_HINT = 320;
/** VSCHAR (RFC 6749 Appendix A.5): printable ASCII, what `state` is defined as. */
const VSCHAR = /^[\x20-\x7e]+$/;
/** Sign-in counters and first-authorisation records kept in memory per instance. */
const MAX_LOCAL_ENTRIES = 10_000;

/** A validated authorisation request, as the sealed transaction carries it. */
export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string | null;
  nonce: string | null;
  codeChallenge: string | null;
  responseMode: "query" | "form_post";
  prompt: string[];
  maxAge: number | null;
  loginHint: string | null;
  offline: boolean;
}

interface Session {
  sid: string;
  ref: PersonaRef;
  authTime: number;
}

// --- Responses to the relying party -------------------------------------------------------------

/** Delivers an authorisation response (success or error) by the request's response mode. */
function deliver(
  request: AuthorizationRequest | Pick<AuthorizationRequest, "redirectUri" | "responseMode">,
  fields: Record<string, string>,
  method: string,
  cookies: readonly string[] = [],
): Response {
  if (request.responseMode === "form_post") {
    const nonce = newNonce();
    return page({
      body: renderFormPost(nonce, request.redirectUri, fields),
      csp: pageCsp(nonce, [new URL(request.redirectUri).origin], true),
      cookies,
    });
  }
  const url = new URL(request.redirectUri);
  for (const [name, value] of Object.entries(fields)) url.searchParams.append(name, value);
  return redirect(url.href, method === "POST" ? 303 : 302, cookies);
}

function errorFields(
  context: IssuerContext,
  error: string,
  description: string,
  state: string | null,
): Record<string, string> {
  const fields: Record<string, string> = { error, error_description: description };
  if (state !== null) fields.state = state;
  if (context.profile.authorizationResponseIss) fields.iss = context.issuer;
  return fields;
}

function errorPage(status: number, title: string, message: string, detail?: string): Response {
  const nonce = newNonce();
  return page({
    status,
    body: renderError(nonce, title, message, detail),
    csp: pageCsp(nonce, []),
  });
}

// --- Parsing and validation ---------------------------------------------------------------------

type Validation = { ok: true; request: AuthorizationRequest } | { ok: false; response: Response };

/** RFC 6749 §4.1.2.1: errors before the client and redirect URI are trusted are shown, never redirected. */
function validate(context: IssuerContext, params: URLSearchParams, method: string): Validation {
  const duplicate = duplicateParameter(params);
  if (duplicate === "client_id" || duplicate === "redirect_uri") {
    return {
      ok: false,
      response: errorPage(400, "Invalid sign-in request", `The request repeats ${duplicate}.`),
    };
  }
  const clientId = param(params, "client_id");
  const client = clientId === undefined ? undefined : context.clients.get(clientId);
  if (!client) {
    log(context, "warn", "authorisation request for an unknown client", {});
    return {
      ok: false,
      response: errorPage(
        400,
        "Unknown application",
        "The application is not registered with this issuer.",
        clientId,
      ),
    };
  }
  const redirectUri = param(params, "redirect_uri");
  if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
    log(context, "warn", "redirect_uri not registered", { clientId: client.clientId });
    return {
      ok: false,
      response: errorPage(
        400,
        "Redirect URI not registered",
        "The application asked to return to an address it did not register. Registered addresses must match exactly.",
        redirectUri,
      ),
    };
  }

  // From here on, errors go back to the application.
  const rawMode = param(params, "response_mode");
  const responseMode = rawMode === "form_post" ? "form_post" : "query";
  const rawState = duplicate === "state" ? null : (param(params, "state") ?? null);
  const fail = (error: string, description: string): Validation => {
    log(context, "info", "authorisation request refused", { clientId: client.clientId, error });
    return {
      ok: false,
      response: deliver(
        { redirectUri, responseMode },
        errorFields(context, error, description, rawState),
        method,
      ),
    };
  };

  if (duplicate !== undefined) return fail("invalid_request", `Parameter ${duplicate} is repeated`);
  if (params.has("request"))
    return fail("request_not_supported", "Request objects are not supported");
  if (params.has("request_uri")) {
    return fail("request_uri_not_supported", "request_uri is not supported");
  }
  if (params.has("registration")) {
    return fail("registration_not_supported", "registration is not supported");
  }
  const responseType = param(params, "response_type");
  if (responseType === undefined) return fail("invalid_request", "response_type is required");
  if (responseType !== "code") {
    return fail(
      "unsupported_response_type",
      "Only the authorization code flow (code) is supported",
    );
  }
  if (rawMode !== undefined && rawMode !== "query" && rawMode !== "form_post") {
    return fail("invalid_request", `response_mode ${rawMode} is not supported (query, form_post)`);
  }

  const scopeParam = param(params, "scope");
  if (scopeParam === undefined) return fail("invalid_scope", "scope is required");
  const scopes = [...new Set(scopeParam.split(" ").filter(Boolean))];
  if (!scopes.includes("openid")) return fail("invalid_scope", "The openid scope is required");
  const unknown = scopes.find((scope) => !client.allowedScopes.includes(scope));
  if (unknown !== undefined) return fail("invalid_scope", `Scope ${unknown} is not allowed`);
  const formPostScope = scopes.find((scope) => context.profile.formPostScopes.includes(scope));
  if (formPostScope !== undefined && responseMode !== "form_post") {
    return fail(
      "invalid_request",
      `response_mode must be form_post when requesting ${formPostScope}`,
    );
  }

  if (rawState !== null && (rawState.length > MAX_STATE || !VSCHAR.test(rawState))) {
    return fail("invalid_request", `state must be 1-${MAX_STATE} printable ASCII characters`);
  }
  if (rawState === null && client.requireState) return fail("invalid_request", "state is required");
  const nonce = param(params, "nonce") ?? null;
  if (nonce !== null && (nonce.length > MAX_NONCE || !VSCHAR.test(nonce))) {
    return fail("invalid_request", `nonce must be 1-${MAX_NONCE} printable ASCII characters`);
  }
  if (nonce === null && client.requireNonce) return fail("invalid_request", "nonce is required");

  const challenge = param(params, "code_challenge") ?? null;
  const challengeMethod = param(params, "code_challenge_method");
  if (challenge === null && challengeMethod !== undefined) {
    return fail("invalid_request", "code_challenge_method without code_challenge");
  }
  if (challenge !== null) {
    // An absent method means plain (RFC 7636 §4.3), which is refused.
    if (challengeMethod !== "S256") {
      return fail("invalid_request", "code_challenge_method must be S256 (plain is not supported)");
    }
    if (!CODE_CHALLENGE.test(challenge)) {
      return fail("invalid_request", "code_challenge must be a base64url SHA-256 (43 characters)");
    }
  } else if (client.requirePkce) {
    return fail("invalid_request", "PKCE is required: send code_challenge with method S256");
  }

  const prompt = [...new Set((param(params, "prompt") ?? "").split(" ").filter(Boolean))];
  const unknownPrompt = prompt.find((value) => !PROMPTS.has(value));
  if (unknownPrompt !== undefined)
    return fail("invalid_request", `prompt ${unknownPrompt} is not supported`);
  if (prompt.includes("none") && prompt.length > 1) {
    return fail("invalid_request", "prompt=none cannot be combined with other values");
  }
  const rawMaxAge = param(params, "max_age");
  if (rawMaxAge !== undefined && !/^\d{1,9}$/.test(rawMaxAge)) {
    return fail("invalid_request", "max_age must be a non-negative integer");
  }
  const loginHint = param(params, "login_hint") ?? null;
  if (loginHint !== null && (loginHint.length > MAX_HINT || /[\p{Cc}\p{Cf}]/u.test(loginHint))) {
    return fail("invalid_request", "login_hint is too long or has control characters");
  }
  return {
    ok: true,
    request: {
      clientId: client.clientId,
      redirectUri,
      scopes,
      state: rawState,
      nonce,
      codeChallenge: challenge,
      responseMode,
      prompt,
      maxAge: rawMaxAge === undefined ? null : Number(rawMaxAge),
      loginHint,
      offline: param(params, "access_type") === "offline",
    },
  };
}

// --- Sessions ---------------------------------------------------------------------------------

function parseRef(value: unknown): PersonaRef | null {
  if (typeof value !== "object" || value === null) return null;
  const ref = value as Record<string, unknown>;
  if (typeof ref.id === "string") return { id: ref.id };
  if (typeof ref.email === "string" && typeof ref.verified === "boolean") {
    return {
      email: ref.email,
      name: typeof ref.name === "string" ? ref.name : null,
      verified: ref.verified,
    };
  }
  return null;
}

export { parseRef };

async function readSession(context: IssuerContext, request: Request): Promise<Session | null> {
  const value = readCookie(request, context.cookies.session);
  if (!value) return null;
  const payload = await context.sealer.unseal("session", value);
  if (!payload || typeof payload.sid !== "string" || typeof payload.at !== "number") return null;
  const ref = parseRef(payload.ref);
  if (!ref) return null;
  if (context.store && (await context.store.has(sessionEndedKey(context, payload.sid))))
    return null;
  return { sid: payload.sid, ref, authTime: payload.at };
}

export { readSession };

function sameRef(a: PersonaRef, b: PersonaRef): boolean {
  if ("id" in a || "id" in b) return "id" in a && "id" in b && a.id === b.id;
  return a.email.toLowerCase() === b.email.toLowerCase();
}

function hintMatches(context: IssuerContext, hint: string, ref: PersonaRef): boolean {
  const lower = hint.toLowerCase();
  if ("id" in ref) {
    const persona = context.personas.find((candidate) => candidate.id === ref.id);
    return persona !== undefined && (persona.id === hint || persona.email?.toLowerCase() === lower);
  }
  return ref.email.toLowerCase() === lower;
}

/** Whether a session is too old for the request (`prompt=login`, or `max_age` exceeded). */
function needsFreshLogin(
  context: IssuerContext,
  request: AuthorizationRequest,
  session: Session,
): boolean {
  if (request.prompt.includes("login")) return true;
  return request.maxAge !== null && nowSec(context) - session.authTime >= request.maxAge;
}

// --- The authorisation response --------------------------------------------------------------

async function pkceChallengeOf(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256(verifier));
}

function anotherClient(context: IssuerContext, clientId: string): string {
  for (const id of context.clients.keys()) if (id !== clientId) return id;
  return "another-client";
}

/** Which of a persona's names this sign-in uses: counted only for personas whose name changes. */
function nextSignIn(context: IssuerContext, ref: PersonaRef): number {
  if (!("id" in ref)) return 0;
  const persona = context.personas.find((candidate) => candidate.id === ref.id);
  if (!Array.isArray(persona?.name)) return 0;
  const key = `id:${ref.id}`;
  const count = context.local.signIns.get(key) ?? 0;
  context.local.signIns.set(key, count + 1);
  return count;
}

/** Apple sends the name only the first time a person authorises an app. */
async function firstAuthorisation(
  context: IssuerContext,
  clientId: string,
  sub: string,
  forced: boolean,
): Promise<boolean> {
  const key = storeKey(context, "first-authorisation", `${clientId}:${sub}`);
  if (context.store) {
    // Remembered for 30 days (Apple: until the person revokes the app), so typed addresses
    // cannot grow the store for ever.
    const first = await context.store.claim(key, context.clock.now() + 30 * 86_400_000);
    return first || forced;
  }
  const known = context.local.authorised.has(key);
  if (!known) {
    if (context.local.authorised.size >= MAX_LOCAL_ENTRIES) context.local.authorised.clear();
    context.local.authorised.add(key);
  }
  return !known || forced;
}

interface IssueInput {
  request: AuthorizationRequest;
  ref: PersonaRef;
  authTime: number;
  sid: string;
  faults: DevIdpFaults;
  forceFirstAuthorisation: boolean;
  method: string;
  cookies: readonly string[];
}

/** Mints the code (sealed), applies authorisation-response faults and delivers the response. */
async function issueCode(context: IssuerContext, input: IssueInput): Promise<Response> {
  const { request, faults } = input;
  const now = nowSec(context);
  const grantId = randomToken(16);
  const nameIndex = nextSignIn(context, input.ref);
  const exp = now + context.lifetimes.codeSec;
  const codeClient = faults.codeForAnotherClient
    ? anotherClient(context, request.clientId)
    : request.clientId;
  const challenge = faults.pkceMismatch
    ? await pkceChallengeOf(randomToken(32))
    : request.codeChallenge;
  const code = await context.sealer.seal("code", {
    exp,
    j: grantId,
    c: codeClient,
    r: request.redirectUri,
    s: request.scopes,
    n: request.nonce,
    cc: challenge,
    at: input.authTime,
    sid: input.sid,
    ref: input.ref,
    ni: nameIndex,
    off: request.offline,
    f: serializeFlowFaults(faults),
  });
  if (faults.codeReplay && context.store) {
    await context.store.claim(storeKey(context, "code", grantId), exp * 1000);
  }

  const fields: Record<string, string> = { code };
  if (request.state !== null) {
    fields.state = faults.tamperedState ? `${request.state}x` : request.state;
  } else if (faults.tamperedState) {
    fields.state = "tampered";
  }
  if (faults.wrongResponseIssuer) fields.iss = `${context.issuer}-mixup`;
  else if (context.profile.authorizationResponseIss) fields.iss = context.issuer;

  const wantsUser = request.scopes.includes("name") || request.scopes.includes("email");
  if (context.profile.nameOnFirstAuthorisationOnly && wantsUser) {
    const identity = await grantIdentity(context, { ref: input.ref, nameIndex }, faults);
    if (
      identity &&
      (await firstAuthorisation(
        context,
        request.clientId,
        identity.sub,
        input.forceFirstAuthorisation,
      ))
    ) {
      // Apple's `user` field: unsigned, so a relying party may use it for the name only.
      const user: Record<string, unknown> = {};
      if (request.scopes.includes("name") && identity.name !== null) {
        user.name = {
          firstName: identity.givenName ?? identity.name,
          lastName: identity.familyName ?? "",
        };
      }
      if (request.scopes.includes("email") && identity.email !== null) user.email = identity.email;
      fields.user = JSON.stringify(user);
    }
  }
  log(context, "info", "authorisation code issued", {
    clientId: request.clientId,
    persona: "id" in input.ref ? input.ref.id : "typed-email",
    faults: Object.keys(faults).join(",") || undefined,
  });
  return deliver(request, fields, input.method, input.cookies);
}

async function sessionCookie(context: IssuerContext, session: Session): Promise<string> {
  const value = await context.sealer.seal("session", {
    exp: nowSec(context) + context.lifetimes.sessionSec,
    sid: session.sid,
    ref: session.ref,
    at: session.authTime,
  });
  return serializeCookie(context.cookies.session, value, {
    path: context.cookies.path,
    secure: context.cookies.secure,
    // Lax: sent on the top-level navigation from the application, which single sign-on needs.
    sameSite: "Lax",
    maxAge: context.lifetimes.sessionSec,
  });
}

// --- The sign-in page ------------------------------------------------------------------------

interface Transaction {
  request: AuthorizationRequest;
  csrf: string;
}

async function sealTransaction(context: IssuerContext, transaction: Transaction): Promise<string> {
  const r = transaction.request;
  return context.sealer.seal("txn", {
    exp: nowSec(context) + context.lifetimes.transactionSec,
    c: r.clientId,
    r: r.redirectUri,
    s: r.scopes,
    st: r.state,
    n: r.nonce,
    cc: r.codeChallenge,
    rm: r.responseMode,
    p: r.prompt,
    ma: r.maxAge,
    lh: r.loginHint,
    off: r.offline,
    x: transaction.csrf,
  });
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function openTransaction(context: IssuerContext, value: string): Promise<Transaction | null> {
  const p = await context.sealer.unseal("txn", value);
  if (!p || typeof p.c !== "string" || typeof p.r !== "string" || typeof p.x !== "string")
    return null;
  if (!Array.isArray(p.s) || !Array.isArray(p.p)) return null;
  // The client may have been reconfigured since the page was served: check again.
  const client = context.clients.get(p.c);
  if (!client?.redirectUris.includes(p.r)) return null;
  return {
    csrf: p.x,
    request: {
      clientId: p.c,
      redirectUri: p.r,
      scopes: p.s.filter((scope): scope is string => typeof scope === "string"),
      state: asStringOrNull(p.st),
      nonce: asStringOrNull(p.n),
      codeChallenge: asStringOrNull(p.cc),
      responseMode: p.rm === "form_post" ? "form_post" : "query",
      prompt: p.p.filter((value): value is string => typeof value === "string"),
      maxAge: typeof p.ma === "number" ? p.ma : null,
      loginHint: asStringOrNull(p.lh),
      offline: p.off === true,
    },
  };
}

function csrfCookie(context: IssuerContext, value: string): string {
  return serializeCookie(context.cookies.csrf, value, {
    path: context.cookies.path,
    secure: context.cookies.secure,
    // Lax, not Strict: it must be sent on the cross-site navigation that opens the page, or each
    // arrival would replace it and break other open sign-in pages. A cross-site POST still
    // never carries it, which is what the CSRF check needs.
    sameSite: "Lax",
    maxAge: context.lifetimes.sessionSec,
  });
}

async function renderSignIn(
  context: IssuerContext,
  request: Request,
  authorization: AuthorizationRequest,
  session: Session | null,
  error: string | null,
): Promise<Response> {
  // One CSRF value per browser, reused across tabs, so several open sign-in pages all work.
  const existing = readCookie(request, context.cookies.csrf);
  const csrf = existing && /^[A-Za-z0-9_-]{22,64}$/.test(existing) ? existing : randomToken(24);
  const transaction = await sealTransaction(context, { request: authorization, csrf });
  const client = context.clients.get(authorization.clientId);
  const hint = authorization.loginHint;
  const personas: PickerPersona[] = context.personas.map((persona) => ({
    id: persona.id,
    name: personaName(persona, context.local.signIns.get(`id:${persona.id}`) ?? 0),
    email: persona.email,
    emailVerified: persona.email === null ? null : (persona.emailVerified ?? true),
    description: persona.description ?? null,
    // Keycloak's own `account` roles are noise on the page; roles of other clients say whose.
    roles: Object.entries(persona.roles?.clients ?? {})
      .filter(([clientId]) => clientId !== "account")
      .flatMap(([clientId, roles]) =>
        roles.map((role) => (clientId === STAFF_ROLE_CLIENT ? role : `${role} (${clientId})`)),
      ),
    signedIn: session !== null && "id" in session.ref && session.ref.id === persona.id,
  }));
  let selected: string | null = personas[0]?.id ?? null;
  let emailHint = "";
  if (hint !== null) {
    const match = context.personas.find((persona) =>
      hintMatches(context, hint, { id: persona.id }),
    );
    if (match) selected = match.id;
    else if (isValidEmail(hint)) {
      selected = null;
      emailHint = hint;
    }
  } else if (session && "id" in session.ref) {
    selected = session.ref.id;
  }
  const nonce = newNonce();
  const body = renderPicker({
    nonce,
    action: endpoint(context, "/authorize/select"),
    transaction,
    issuer: context.issuer,
    standsInFor: context.profile.standsInFor,
    clientName: client?.displayName ?? authorization.clientId,
    clientId: authorization.clientId,
    redirectUri: authorization.redirectUri,
    scopes: authorization.scopes,
    personas,
    selected,
    emailHint,
    faultPicker: context.faultPicker,
    faultsAvailable: (name) => !("needsStore" in FAULT_CATALOGUE[name]) || context.store !== null,
    firstAuthorisationChoice: context.profile.nameOnFirstAuthorisationOnly,
    error,
    reauthentication: session !== null && needsFreshLogin(context, authorization, session),
  });
  return page({
    status: error === null ? 200 : 400,
    body,
    csp: pageCsp(nonce, [context.issuerUrl.origin, new URL(authorization.redirectUri).origin]),
    cookies: existing === csrf ? [] : [csrfCookie(context, csrf)],
  });
}

// --- Handlers ---------------------------------------------------------------------------------

export async function handleAuthorize(context: IssuerContext, request: Request): Promise<Response> {
  let params: URLSearchParams;
  if (request.method === "GET") {
    params = new URL(request.url).searchParams;
  } else if (request.method === "POST") {
    const form = await readForm(request);
    if (!form.ok)
      return errorPage(400, "Invalid sign-in request", "The request body could not be read.");
    params = form.params;
  } else {
    return methodNotAllowed(["GET", "POST"]);
  }
  const validation = validate(context, params, request.method);
  if (!validation.ok) return validation.response;
  const authorization = validation.request;

  const session = await readSession(context, request);
  const hintMismatch =
    session !== null &&
    authorization.loginHint !== null &&
    !hintMatches(context, authorization.loginHint, session.ref);
  const usable =
    session !== null && !needsFreshLogin(context, authorization, session) && !hintMismatch;

  if (authorization.prompt.includes("none")) {
    if (!session || !usable) {
      return deliver(
        authorization,
        errorFields(context, "login_required", "The user must sign in", authorization.state),
        request.method,
      );
    }
  }
  const interactive =
    !usable ||
    authorization.prompt.includes("select_account") ||
    authorization.prompt.includes("consent");
  if (session && usable && !interactive) {
    return issueCode(context, {
      request: authorization,
      ref: session.ref,
      authTime: session.authTime,
      sid: session.sid,
      faults: mergeFaults(context.standingFaults, {}),
      forceFirstAuthorisation: false,
      method: request.method,
      cookies: [],
    });
  }
  return renderSignIn(context, request, authorization, session, null);
}

/** The sign-in page's answer. */
export async function handleSelect(context: IssuerContext, request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin") {
    return errorPage(
      403,
      "Request refused",
      "The sign-in form must be submitted from this issuer's own page.",
    );
  }
  const form = await readForm(request);
  if (!form.ok) return errorPage(400, "Invalid sign-in request", "The form could not be read.");
  const params = form.params;
  const duplicate = duplicateParameter(
    new URLSearchParams([...params].filter(([key]) => key !== "fault")),
  );
  if (duplicate !== undefined) {
    return errorPage(400, "Invalid sign-in request", `The form repeats ${duplicate}.`);
  }
  const transaction = await openTransaction(context, param(params, "txn") ?? "");
  if (!transaction) {
    return errorPage(
      400,
      "This sign-in page has expired",
      "Return to the application and start signing in again.",
    );
  }
  const cookie = readCookie(request, context.cookies.csrf);
  if (!cookie || !(await timingSafeEqual(cookie, transaction.csrf))) {
    return errorPage(
      403,
      "Request refused",
      "The sign-in form was not submitted from the page this browser received. Return to the application and try again.",
    );
  }
  const authorization = transaction.request;
  if (param(params, "action") === "cancel") {
    return deliver(
      authorization,
      errorFields(context, "access_denied", "The user cancelled the sign-in", authorization.state),
      "POST",
    );
  }

  const flowFaults = parseFlowFaults(params.getAll("fault"));
  if (flowFaults === null) {
    return errorPage(400, "Unknown fault", "The form named a fault this issuer does not have.");
  }
  if (flowFaults.codeReplay && !context.store) {
    return errorPage(
      400,
      "Fault unavailable",
      "codeReplay needs a store; this issuer runs without one.",
    );
  }
  const session = await readSession(context, request);

  let ref: PersonaRef;
  const choice = param(params, "persona");
  if (choice === "__email__" || choice === undefined) {
    const email = (param(params, "email") ?? "").trim();
    if (!isValidEmail(email)) {
      return renderSignIn(context, request, authorization, session, "Enter a valid email address.");
    }
    const name = (param(params, "name") ?? "")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .trim()
      .slice(0, 100);
    ref = { email, name: name || null, verified: param(params, "email_verified") === "true" };
  } else {
    if (!context.personas.some((persona) => persona.id === choice)) {
      return errorPage(
        400,
        "Unknown persona",
        "The form named a persona this issuer does not have.",
      );
    }
    ref = { id: choice };
  }

  const now = nowSec(context);
  const continuing =
    session !== null &&
    sameRef(session.ref, ref) &&
    !needsFreshLogin(context, authorization, session);
  const next: Session = {
    sid: session !== null && sameRef(session.ref, ref) ? session.sid : randomToken(16),
    ref,
    authTime: continuing && session ? session.authTime : now,
  };
  return issueCode(context, {
    request: authorization,
    ref,
    authTime: next.authTime,
    sid: next.sid,
    faults: mergeFaults(context.standingFaults, flowFaults),
    forceFirstAuthorisation: param(params, "first_authorisation") === "true",
    method: "POST",
    cookies: [await sessionCookie(context, next)],
  });
}

export { pkceChallengeOf };
