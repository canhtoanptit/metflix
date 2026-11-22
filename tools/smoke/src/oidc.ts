/**
 * Federated sign-in driven over HTTP, the way a browser goes through it, against the development
 * issuer a non-production deployment mounts at `/dev-idp/*` (packages/dev-idp): the member's
 * `GET /auth/oidc/{provider}/start`, the issuer's sign-in page (a persona or a typed address,
 * optional faults), the authorisation response (a query redirect, or Apple's auto-submitting
 * form post), and the callback's redirect to `returnTo?oidc=<outcome>`. Also the staff
 * console's authorisation code flow with PKCE, for a bearer token on the staff API.
 *
 * Nothing here knows the issuer's internals: only its published discovery document, its HTML
 * forms (marked `data-dev-idp`) and the redirects a browser would follow.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  API_BASE_PATH,
  OIDC_OUTCOMES,
  OIDC_RESULT_PARAM,
  type OidcOutcome,
  STAFF_CLIENT_ID,
  type StaffRole,
} from "@webflix/contracts";
import { check, fail, SkipSignal } from "./expect.ts";
import type { Agent, HttpResult } from "./http.ts";

export type MemberIssuer = "google" | "apple";
export type OidcIntent = "signin" | "link" | "reauth";

/** What to answer on the issuer's sign-in page. */
export interface IssuerChoice {
  /** A shipped persona (`new-member`, `demo-verified`, …). */
  persona?: string;
  /** Or an address typed on the page: a persona the issuer mints for it (stable per address). */
  email?: { address: string; name?: string; verified?: boolean };
  /** Faults for this sign-in only (packages/dev-idp `FAULT_CATALOGUE` names). */
  faults?: string[];
  /** Press Cancel: the application receives `access_denied`. */
  cancel?: boolean;
  /** Apple: treat this as the first authorisation (Apple sends the name only then). */
  firstAuthorisation?: boolean;
  /**
   * Change the authorisation response on its way to the application, as whoever controls the
   * browser could (Apple's unsigned `user` field, for one).
   */
  tamper?: (fields: URLSearchParams) => void;
}

export interface FederatedResult {
  /** The `?oidc=` outcome the callback redirected to (null: no outcome parameter). */
  outcome: OidcOutcome | null;
  /** The path the callback sent the browser to, outcome included. */
  location: string;
  /** How the authorisation response came back. */
  mode: "query" | "form_post";
  /** Whether the issuer showed its sign-in page (false: its session signed in at once). */
  interactive: boolean;
  /** The start redirect (transaction cookie attributes are asserted on it). */
  start: HttpResult;
  /** The issuer's authorisation URL the start redirected to (with its parameters). */
  authorizeUrl: URL;
  /** The callback request's answer (303 to `returnTo`). */
  callback: HttpResult;
  /** The callback request as the browser sent it (to replay it from another browser). */
  delivery: { path: string; method: "GET" | "POST"; body?: string };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

function unescapeHtml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ENTITIES[entity] ?? "");
}

/** One of the issuer's own forms (`data-dev-idp="<kind>"`): its action and hidden fields. */
export function parseIssuerForm(
  html: string,
  kind: "sign-in" | "form-post",
): { action: string; fields: URLSearchParams } | null {
  const form = new RegExp(
    `<form method="post" action="([^"]*)"[^>]*data-dev-idp="${kind}"[^>]*>([\\s\\S]*?)</form>`,
  ).exec(html);
  if (!form) return null;
  const fields = new URLSearchParams();
  for (const input of (form[2] ?? "").matchAll(
    /<input type="hidden" name="([^"]*)" value="([^"]*)">/g,
  )) {
    fields.append(unescapeHtml(input[1] ?? ""), unescapeHtml(input[2] ?? ""));
  }
  return { action: unescapeHtml(form[1] ?? ""), fields };
}

/** The heading and first paragraph of an issuer error page, for a failure message. */
function issuerPageSummary(result: HttpResult): string {
  const html = result.text();
  const title = /<h1>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";
  const message = /<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  return `${result.status} ${unescapeHtml(title)} ${unescapeHtml(message)}`
    .replace(/<[^>]+>/g, "")
    .trim();
}

function isRedirect(result: HttpResult): boolean {
  return [301, 302, 303, 307, 308].includes(result.status) && result.headers.has("Location");
}

/** The development issuer's realm path (`/dev-idp/google`) for a member issuer. */
export function issuerRealm(provider: MemberIssuer): string {
  return `/dev-idp/${provider}`;
}

/**
 * `GET /auth/oidc/{provider}/start` without following its redirect. A refusal (a problem
 * document) is returned as is for the check to assert.
 */
export function startFederated(
  agent: Agent,
  provider: MemberIssuer,
  query: { intent?: OidcIntent; returnTo?: string } = {},
): Promise<HttpResult> {
  const params = new URLSearchParams();
  if (query.intent) params.set("intent", query.intent);
  if (query.returnTo) params.set("returnTo", query.returnTo);
  const search = params.size > 0 ? `?${params}` : "";
  return agent.fetch(`${API_BASE_PATH}/auth/oidc/${provider}/start${search}`, {
    followRedirects: false,
  });
}

/**
 * Where the issuer's authorisation endpoint is, from the start redirect. The development
 * issuer builds its URLs from the deployment's public origin; when the suite reaches the
 * deployment through another port of the same host, that origin is aliased to the base URL.
 * Anything else (a real issuer, another host) cannot be driven without a browser.
 */
export function issuerLocation(
  agent: Agent,
  start: HttpResult,
  provider: MemberIssuer,
): URL | { unsupported: string } {
  const location = start.headers.get("Location") ?? "";
  const url = new URL(location, agent.origin);
  if (!url.pathname.startsWith(`${issuerRealm(provider)}/`)) {
    return {
      unsupported: `the deployment sends ${provider} sign-in to ${url.origin}${url.pathname}, not to the development issuer (${issuerRealm(provider)}): a real issuer needs a browser and a real account`,
    };
  }
  if (url.origin !== agent.origin) {
    try {
      agent.alias(url.origin);
    } catch {
      return {
        unsupported: `the development issuer is published at ${url.origin} (WEBFLIX_PUBLIC_ORIGIN), another host than the base URL ${agent.origin}: run the suite against the public origin`,
      };
    }
  }
  return url;
}

/**
 * A whole federated sign-in: start, the issuer's page, the authorisation response, the
 * callback. Fails the check with the exchange when a step does not answer as a browser needs
 * (the start refused, the issuer showed an error page, the callback did not redirect).
 */
export async function federatedSignIn(
  agent: Agent,
  provider: MemberIssuer,
  choice: IssuerChoice,
  query: { intent?: OidcIntent; returnTo?: string } = {},
): Promise<FederatedResult> {
  const start = await startFederated(agent, provider, query);
  if (start.status !== 302) {
    fail(`GET /auth/oidc/${provider}/start did not redirect to the issuer`, {
      expected: "302 to the issuer's authorisation endpoint",
      observed: `${start.status} ${start.exchange.responseBody ?? ""}`.trim(),
      exchange: start.exchange,
    });
  }
  const authorizeUrl = issuerLocation(agent, start, provider);
  // A real issuer (or one on another host) is not a deviation: the journey needs a browser.
  if ("unsupported" in authorizeUrl) throw new SkipSignal(authorizeUrl.unsupported);
  const finished = await answerIssuer(agent, authorizeUrl, choice);
  const callback = finished.callback;
  check(callback.status === 303 || callback.status === 302, "the callback did not redirect", {
    expected: "303 to returnTo?oidc=<outcome> (the callbacks never answer a problem document)",
    observed: `${callback.status} ${callback.exchange.responseBody ?? ""}`.trim(),
    exchange: callback.exchange,
  });
  const location = callback.headers.get("Location") ?? "";
  const target = new URL(location, agent.origin);
  check(
    agent.ownPath(target.href) !== null,
    "the callback redirected away from the deployment (open redirect?)",
    { expected: "a same-origin path", observed: location, exchange: callback.exchange },
  );
  const raw = target.searchParams.get(OIDC_RESULT_PARAM);
  const outcome = (OIDC_OUTCOMES as readonly string[]).includes(raw ?? "")
    ? (raw as OidcOutcome)
    : null;
  return {
    outcome,
    location: `${target.pathname}${target.search}`,
    mode: finished.mode,
    interactive: finished.interactive,
    start,
    authorizeUrl,
    callback,
    delivery: finished.delivery,
  };
}

/** Send a callback delivery again (from another browser: a replayed or stolen response). */
export function replayDelivery(
  agent: Agent,
  delivery: FederatedResult["delivery"],
): Promise<HttpResult> {
  return agent.fetch(delivery.path, {
    method: delivery.method,
    ...(delivery.body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: delivery.body,
        }),
    followRedirects: false,
  });
}

/** The `?oidc=` outcome of a callback answer (null when it carries none). */
export function outcomeOf(agent: Agent, callback: HttpResult): OidcOutcome | null {
  const location = callback.headers.get("Location");
  if (!location) return null;
  const raw = new URL(location, agent.origin).searchParams.get(OIDC_RESULT_PARAM);
  return (OIDC_OUTCOMES as readonly string[]).includes(raw ?? "") ? (raw as OidcOutcome) : null;
}

/**
 * Follow an authorisation URL at the development issuer: answer its sign-in page (or let its
 * session sign in at once), then deliver the authorisation response to the application as the
 * browser would (a GET for a query response, a cross-site-style form POST without the client
 * header for `form_post`). Returns the application's answer to that delivery.
 */
export async function answerIssuer(
  agent: Agent,
  authorizeUrl: URL,
  choice: IssuerChoice,
): Promise<{
  callback: HttpResult;
  mode: "query" | "form_post";
  interactive: boolean;
  redirectTo: URL;
  delivery: FederatedResult["delivery"];
}> {
  const first = await agent.fetch(authorizeUrl.href, { followRedirects: false });
  let response = first;
  let interactive = false;
  if (!isRedirect(first)) {
    const form = first.status === 200 ? parseIssuerForm(first.text(), "sign-in") : null;
    if (!form) {
      fail("the development issuer did not show its sign-in page", {
        expected: "200 with the persona picker, or a redirect (single sign-on)",
        observed: issuerPageSummary(first),
        exchange: first.exchange,
      });
    }
    interactive = true;
    const body = new URLSearchParams(form.fields);
    if (choice.cancel) {
      body.set("action", "cancel");
    } else {
      body.set("action", "continue");
      if (choice.persona !== undefined) {
        body.set("persona", choice.persona);
      } else if (choice.email !== undefined) {
        body.set("persona", "__email__");
        body.set("email", choice.email.address);
        if (choice.email.name !== undefined) body.set("name", choice.email.name);
        if (choice.email.verified !== false) body.set("email_verified", "true");
      } else {
        throw new Error("Choose a persona or an email");
      }
      for (const fault of choice.faults ?? []) body.append("fault", fault);
      if (choice.firstAuthorisation) body.set("first_authorisation", "true");
    }
    response = await agent.fetch(form.action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      followRedirects: false,
    });
  }
  if (isRedirect(response)) {
    const redirectTo = new URL(response.headers.get("Location") ?? "", agent.origin);
    const path = agent.ownPath(redirectTo.href);
    if (path === null) {
      fail("the issuer redirected the browser to another origin", {
        observed: redirectTo.href,
        exchange: response.exchange,
      });
    }
    let delivered = path;
    if (choice.tamper) {
      const url = new URL(path, agent.origin);
      choice.tamper(url.searchParams);
      delivered = `${url.pathname}${url.search}`;
    }
    const callback = await agent.fetch(delivered, { followRedirects: false });
    return {
      callback,
      mode: "query",
      interactive,
      redirectTo,
      delivery: { path: delivered, method: "GET" },
    };
  }
  const post = response.status === 200 ? parseIssuerForm(response.text(), "form-post") : null;
  if (!post) {
    fail("the development issuer did not answer with an authorisation response", {
      expected: "a redirect to the callback, or Apple's auto-submitting form post",
      observed: issuerPageSummary(response),
      exchange: response.exchange,
    });
  }
  const redirectTo = new URL(post.action, agent.origin);
  const path = agent.ownPath(redirectTo.href);
  if (path === null) {
    fail("the issuer's form posts to another origin", {
      observed: post.action,
      exchange: response.exchange,
    });
  }
  // A cross-site form post carries no client header and no JSON: exactly what Apple sends.
  choice.tamper?.(post.fields);
  const body = post.fields.toString();
  const callback = await agent.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    followRedirects: false,
  });
  return {
    callback,
    mode: "form_post",
    interactive,
    redirectTo,
    delivery: { path, method: "POST", body },
  };
}

// --- The staff issuer ------------------------------------------------------------------------

export interface IssuerDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

/** The development issuer's discovery document for a realm, or the reason it is absent. */
export async function discoverIssuer(
  agent: Agent,
  realm: string,
): Promise<{ document: IssuerDiscovery } | { absent: string }> {
  const result = await agent.fetch(`/dev-idp/${realm}/.well-known/openid-configuration`, {
    followRedirects: false,
  });
  const type = result.headers.get("Content-Type") ?? "";
  if (result.status !== 200 || !type.includes("json")) {
    return {
      absent: `GET /dev-idp/${realm}/.well-known/openid-configuration answered ${result.status} ${type || "(no content type)"}`,
    };
  }
  const document = result.json<Partial<IssuerDiscovery>>();
  if (
    typeof document.issuer !== "string" ||
    typeof document.authorization_endpoint !== "string" ||
    typeof document.token_endpoint !== "string"
  ) {
    return { absent: `the ${realm} discovery document lacks its endpoints` };
  }
  return { document: document as IssuerDiscovery };
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * A staff access token for one development persona (`staff-support`, …, `staff-no-role`):
 * the console's authorisation code flow with PKCE as client `webflix-admin`, redirected to the
 * console's callback (read from the redirect, never followed), then the token endpoint.
 */
export async function staffAccessToken(agent: Agent, persona: string): Promise<string> {
  return (await staffTokens(agent, persona)).accessToken;
}

/** The access token and the ID token the staff issuer returns for `persona`. */
export async function staffTokens(
  agent: Agent,
  persona: string,
): Promise<{ accessToken: string; idToken: string | null }> {
  const discovered = await discoverIssuer(agent, "staff");
  if ("absent" in discovered) fail(`the staff issuer is not reachable: ${discovered.absent}`);
  const { document } = discovered;
  const publicOrigin = new URL(document.issuer).origin;
  if (publicOrigin !== agent.origin) agent.alias(publicOrigin);
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const redirectUri = `${publicOrigin}/admin/auth/callback`;
  const authorize = new URL(document.authorization_endpoint);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: STAFF_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email",
    state: base64url(randomBytes(16)),
    nonce: base64url(randomBytes(16)),
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "login",
  })) {
    authorize.searchParams.set(name, value);
  }
  const page = await agent.fetch(authorize.href, { followRedirects: false });
  const form = page.status === 200 ? parseIssuerForm(page.text(), "sign-in") : null;
  if (!form) {
    fail("the staff issuer did not show its sign-in page", {
      observed: issuerPageSummary(page),
      exchange: page.exchange,
    });
  }
  const body = new URLSearchParams(form.fields);
  body.set("action", "continue");
  body.set("persona", persona);
  const answer = await agent.fetch(form.action, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    followRedirects: false,
  });
  const code = isRedirect(answer)
    ? new URL(answer.headers.get("Location") ?? "", agent.origin).searchParams.get("code")
    : null;
  if (!code) {
    fail(`the staff issuer did not return a code for ${persona}`, {
      observed: isRedirect(answer)
        ? (answer.headers.get("Location") ?? "")
        : issuerPageSummary(answer),
      exchange: answer.exchange,
    });
  }
  const token = await agent.fetch(document.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: STAFF_CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  });
  const json =
    token.status === 200 ? token.json<{ access_token?: unknown; id_token?: unknown }>() : {};
  if (typeof json.access_token !== "string") {
    fail(`the staff issuer's token endpoint refused the code for ${persona}`, {
      observed: `${token.status} ${token.exchange.responseBody ?? ""}`,
      exchange: token.exchange,
    });
  }
  return {
    accessToken: json.access_token,
    idToken: typeof json.id_token === "string" ? json.id_token : null,
  };
}

/** The development staff personas: one Webflix role each, and two without any. */
export const STAFF_PERSONAS: Record<StaffRole | "none" | "other-client", string> = {
  support: "staff-support",
  billing: "staff-billing",
  content: "staff-content",
  experiments: "staff-experiments",
  admin: "staff-admin",
  none: "staff-no-role",
  "other-client": "staff-other-client-admin",
};
