/**
 * Driving the issuer like a browser would, without one: a small cookie jar and a driver for the
 * authorisation endpoint and the sign-in page.
 */
import { type DevIdpFaults, serializeFlowFaults } from "../faults.ts";

export type FetchLike = (request: Request) => Promise<Response>;

interface StoredCookie {
  name: string;
  value: string;
  origin: string;
  path: string;
  expiresAt: number | null;
}

/** Enough of a browser's cookie store for the issuer's own cookies: by origin and path. */
export class CookieJar {
  private cookies: StoredCookie[] = [];

  /** Records the `Set-Cookie` headers of a response to `url`. */
  store(url: string | URL, response: Response): void {
    const origin = new URL(url).origin;
    for (const header of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const cookie: StoredCookie = {
        name: pair.slice(0, index),
        value: pair.slice(index + 1),
        origin,
        path: "/",
        expiresAt: null,
      };
      for (const attribute of attributes) {
        const [key = "", value = ""] = attribute.split("=");
        if (key.toLowerCase() === "path") cookie.path = value || "/";
        if (key.toLowerCase() === "max-age") cookie.expiresAt = Date.now() + Number(value) * 1000;
      }
      this.cookies = this.cookies.filter(
        (existing) =>
          !(
            existing.name === cookie.name &&
            existing.origin === origin &&
            existing.path === cookie.path
          ),
      );
      if (cookie.expiresAt === null || cookie.expiresAt > Date.now()) this.cookies.push(cookie);
    }
  }

  /** The `Cookie` header a browser would send to `url`, or undefined. */
  header(url: string | URL): string | undefined {
    const target = new URL(url);
    const now = Date.now();
    const matching = this.cookies.filter(
      (cookie) =>
        cookie.origin === target.origin &&
        (cookie.expiresAt === null || cookie.expiresAt > now) &&
        (target.pathname === cookie.path ||
          target.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`)),
    );
    return matching.length
      ? matching.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
      : undefined;
  }

  get(name: string): string | undefined {
    return this.cookies.find((cookie) => cookie.name === name)?.value;
  }

  clear(): void {
    this.cookies = [];
  }
}

/** What the sign-in page is asked to do. */
export interface SignInChoice {
  /** A configured persona id. */
  persona?: string;
  /** Or an address typed on the page. */
  email?: { address: string; name?: string; verified?: boolean };
  /** Flow faults for this sign-in only. */
  faults?: DevIdpFaults;
  /** Press Cancel: the application receives `error=access_denied`. */
  cancel?: boolean;
  /** Apple profile: treat this as the persona's first authorisation of the app. */
  firstAuthorisation?: boolean;
}

/** The authorisation response, as the application's redirect URI would receive it. */
export interface AuthorizationOutcome {
  mode: "query" | "form_post";
  /** The redirect URI without the response parameters. */
  redirectUri: string;
  params: URLSearchParams;
  code: string | null;
  state: string | null;
  iss: string | null;
  error: string | null;
  errorDescription: string | null;
  /** Apple's `user` form field (JSON), on a first authorisation. */
  user: string | null;
  /** Whether the sign-in page was shown (false for single sign-on and prompt=none). */
  interactive: boolean;
  /** The request a browser would now send to the application. */
  toRequest(init?: { headers?: Record<string, string> }): Request;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

function unescapeHtml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ENTITIES[entity] ?? "");
}

interface ParsedForm {
  action: string;
  fields: URLSearchParams;
}

/** Reads one of the issuer's own forms (`data-dev-idp="<kind>"`) out of its HTML. */
function parseForm(htmlText: string, kind: string): ParsedForm | null {
  const formMatch = new RegExp(
    `<form method="post" action="([^"]*)"[^>]*data-dev-idp="${kind}"[^>]*>([\\s\\S]*?)</form>`,
  ).exec(htmlText);
  if (!formMatch) return null;
  const fields = new URLSearchParams();
  for (const input of (formMatch[2] ?? "").matchAll(
    /<input type="hidden" name="([^"]*)" value="([^"]*)">/g,
  )) {
    fields.append(unescapeHtml(input[1] ?? ""), unescapeHtml(input[2] ?? ""));
  }
  return { action: unescapeHtml(formMatch[1] ?? ""), fields };
}

function pageError(status: number, htmlText: string): Error {
  const title = /<h1>([\s\S]*?)<\/h1>/.exec(htmlText)?.[1] ?? "unexpected page";
  const message = /<\/h1>\s*<p>([\s\S]*?)<\/p>/.exec(htmlText)?.[1] ?? "";
  return new Error(`Issuer answered ${status}: ${unescapeHtml(title)}. ${unescapeHtml(message)}`);
}

function outcome(
  mode: "query" | "form_post",
  redirectUri: string,
  params: URLSearchParams,
  interactive: boolean,
): AuthorizationOutcome {
  const get = (name: string) => params.get(name);
  return {
    mode,
    redirectUri,
    params,
    code: get("code"),
    state: get("state"),
    iss: get("iss"),
    error: get("error"),
    errorDescription: get("error_description"),
    user: get("user"),
    interactive,
    toRequest(init = {}) {
      if (mode === "query") {
        const url = new URL(redirectUri);
        for (const [name, value] of params) url.searchParams.append(name, value);
        return new Request(url, { headers: init.headers });
      }
      return new Request(redirectUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...init.headers },
        body: params.toString(),
      });
    },
  };
}

/** Splits a redirect to the application into its URI and the response parameters it carries. */
function fromRedirect(location: string, interactive: boolean): AuthorizationOutcome {
  const url = new URL(location);
  const params = new URLSearchParams();
  for (const name of ["code", "state", "iss", "error", "error_description", "user"]) {
    const value = url.searchParams.get(name);
    if (value !== null) {
      params.set(name, value);
      url.searchParams.delete(name);
    }
  }
  return outcome("query", url.href, params, interactive);
}

async function responseOutcome(
  response: Response,
  interactive: boolean,
): Promise<AuthorizationOutcome | { page: string }> {
  if (response.status === 302 || response.status === 303) {
    const location = response.headers.get("Location");
    if (!location) throw new Error("Redirect without a Location");
    return fromRedirect(location, interactive);
  }
  const text = await response.text();
  if (response.status !== 200) throw pageError(response.status, text);
  const formPost = parseForm(text, "form-post");
  if (formPost) return outcome("form_post", formPost.action, formPost.fields, interactive);
  return { page: text };
}

export interface DriveOptions {
  /** How requests reach the issuer: an in-process handler or `fetch` to a real port. */
  fetch: FetchLike;
  /** The browser's cookies (keep one per simulated browser for single sign-on). */
  jar?: CookieJar;
}

/**
 * Follows an authorisation URL (for example the `Location` an application's sign-in start
 * returned), answers the sign-in page as `choice` says, and returns the authorisation response
 * the application's redirect URI would receive. Throws when the issuer shows an error page.
 */
export async function completeAuthorization(
  authorizationUrl: string | URL,
  choice: SignInChoice,
  options: DriveOptions,
): Promise<AuthorizationOutcome> {
  const jar = options.jar ?? new CookieJar();
  const url = new URL(authorizationUrl);
  const cookie = jar.header(url);
  const first = await options.fetch(
    new Request(url, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" }),
  );
  jar.store(url, first);
  const initial = await responseOutcome(first, false);
  if (!("page" in initial)) return initial;
  const form = parseForm(initial.page, "sign-in");
  if (!form) throw new Error("The issuer did not show its sign-in page");

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
    for (const fault of serializeFlowFaults(choice.faults ?? {})) body.append("fault", fault);
    if (choice.firstAuthorisation) body.set("first_authorisation", "true");
  }
  const action = new URL(form.action);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const actionCookie = jar.header(action);
  if (actionCookie) headers.Cookie = actionCookie;
  const second = await options.fetch(
    new Request(action, { method: "POST", headers, body: body.toString(), redirect: "manual" }),
  );
  jar.store(action, second);
  const result = await responseOutcome(second, true);
  if ("page" in result)
    throw new Error("The issuer showed its sign-in page again (invalid choice?)");
  return result;
}
