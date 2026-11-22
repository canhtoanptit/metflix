/**
 * Low-level helpers for the provider's unit tests: raw authorisation URLs, the sign-in page's
 * form, token requests. Built on the test kit where that is what is under test.
 */
import {
  CookieJar,
  createPkce,
  TEST_REDIRECT_URI,
  type TestIssuer,
} from "../../src/testing/index.ts";

export function basic(id: string, secret: string): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
  return `Basic ${btoa(`${encode(id)}:${encode(secret)}`)}`;
}

export const BASIC = basic("confidential-basic", "confidential-basic-secret");

export interface AuthorizeParams {
  [name: string]: string | undefined;
}

/** An authorisation URL for confidential-basic with every required parameter, overridable. */
export async function authorizeUrl(
  t: TestIssuer,
  params: AuthorizeParams = {},
): Promise<{ url: URL; verifier: string }> {
  const { verifier, challenge } = await createPkce();
  const url = new URL(`${t.issuer}/authorize`);
  const all: AuthorizeParams = {
    response_type: "code",
    client_id: "confidential-basic",
    redirect_uri: TEST_REDIRECT_URI,
    scope: "openid email profile",
    state: "state-123",
    nonce: "nonce-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...params,
  };
  for (const [name, value] of Object.entries(all))
    if (value !== undefined) url.searchParams.set(name, value);
  return { url, verifier };
}

export interface Picker {
  response: Response;
  html: string;
  txn: string;
  action: string;
  jar: CookieJar;
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** GETs the authorisation URL and expects the sign-in page. */
export async function openPicker(t: TestIssuer, url: URL, jar = new CookieJar()): Promise<Picker> {
  const cookie = jar.header(url);
  const response = await t.fetch(new Request(url, { headers: cookie ? { Cookie: cookie } : {} }));
  jar.store(url, response);
  const html = await response.clone().text();
  const txn = /name="txn" value="([^"]+)"/.exec(html)?.[1];
  const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1];
  if (response.status !== 200 || !txn || !action) {
    throw new Error(`Expected the sign-in page, got ${response.status}: ${html.slice(0, 300)}`);
  }
  return { response, html, txn: unescapeHtml(txn), action: unescapeHtml(action), jar };
}

/** POSTs the sign-in form. `fields` override; `cookie: null` sends no cookie. */
export async function submitPicker(
  t: TestIssuer,
  picker: Picker,
  fields: Record<string, string | string[]>,
  options: { cookie?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const body = new URLSearchParams({ txn: picker.txn, action: "continue" });
  for (const [name, value] of Object.entries(fields)) {
    body.delete(name);
    for (const item of Array.isArray(value) ? value : [value]) body.append(name, item);
  }
  const cookie = options.cookie === undefined ? picker.jar.header(picker.action) : options.cookie;
  const response = await t.fetch(
    new Request(picker.action, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(cookie ? { Cookie: cookie } : {}),
        ...options.headers,
      },
      body,
    }),
  );
  picker.jar.store(picker.action, response);
  return response;
}

/** The parameters of a redirect to the application. */
export function redirectParams(response: Response): URLSearchParams {
  const location = response.headers.get("Location");
  if (!location) throw new Error(`No redirect (status ${response.status})`);
  return new URL(location).searchParams;
}

export interface TokenCall {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

export async function tokenRequest(
  t: TestIssuer,
  body: Record<string, string>,
  headers: Record<string, string> = { Authorization: BASIC },
): Promise<TokenCall> {
  const response = await t.fetch(
    new Request(`${t.issuer}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    headers: response.headers,
  };
}

/** A fresh code for confidential-basic (persona new-member unless given). */
export async function freshCode(
  t: TestIssuer,
  params: AuthorizeParams = {},
  persona = "new-member",
): Promise<{ code: string; verifier: string; jar: CookieJar }> {
  const { url, verifier } = await authorizeUrl(t, params);
  const jar = new CookieJar();
  const outcome = await t.completeAuthorization(url, { persona }, jar);
  if (!outcome.code) throw new Error(`No code: ${outcome.error} ${outcome.errorDescription}`);
  return { code: outcome.code, verifier, jar };
}

export async function redeem(
  t: TestIssuer,
  code: string,
  verifier: string | undefined,
  extra: Record<string, string> = {},
  headers?: Record<string, string>,
): Promise<TokenCall> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: TEST_REDIRECT_URI,
    ...extra,
  };
  if (verifier !== undefined) body.code_verifier = verifier;
  return tokenRequest(t, body, headers);
}

export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
} {
  const [h = "", c = ""] = token.split(".");
  const json = (part: string) =>
    JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
  return { header: json(h), claims: json(c) };
}

export async function userinfo(
  t: TestIssuer,
  token: string,
  init: { method?: string } = {},
): Promise<Response> {
  return t.fetch(
    new Request(`${t.issuer}/userinfo`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}
