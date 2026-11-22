/**
 * The staff session: what a page load does (callback, reload, signed out), PKCE and state, the
 * issuer mix-up check, renewal and its refusal, sign-out, and that no token is ever stored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssuerMetadata } from "../src/auth/oidc.ts";
import { createStaffSession, type SessionDeps } from "../src/auth/session.ts";
import { markSignedOut } from "../src/auth/transaction.ts";
import { parseRuntimeConfig } from "../src/config/runtime.ts";

const ORIGIN = "http://localhost:5890";
const config = parseRuntimeConfig(
  { issuer: "/dev-idp/staff", clientId: "webflix-admin", scope: "openid profile email" },
  ORIGIN,
  "/admin/",
);
const metadata: IssuerMetadata = {
  issuer: config.issuer,
  authorizationEndpoint: `${config.issuer}/authorize`,
  tokenEndpoint: `${config.issuer}/token`,
  endSessionEndpoint: `${config.issuer}/logout`,
  issInResponse: true,
};

const ACCESS = "header.access-token-payload.signature";
const REFRESH = "refresh-token-value-0001";
const ID_TOKEN = "header.id-token-payload.signature";

interface Harness {
  session: ReturnType<typeof createStaffSession>;
  navigations: string[];
  replaced: string[];
  posted: unknown[];
  now: { value: number };
}

function harness(overrides: Partial<SessionDeps> = {}): Harness {
  const navigations: string[] = [];
  const replaced: string[] = [];
  const posted: unknown[] = [];
  const now = { value: Date.parse("2026-11-23T10:00:00Z") };
  const session = createStaffSession({
    config,
    now: () => now.value,
    navigate: (url) => navigations.push(url),
    replaceUrl: (path) => replaced.push(path),
    discover: async () => metadata,
    channel: {
      postMessage: (message: unknown) => posted.push(message),
      addEventListener: () => undefined,
      close: () => undefined,
    } as unknown as BroadcastChannel,
    ...overrides,
  });
  return { session, navigations, replaced, posted, now };
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Every value in both storages and the cookie jar, to prove no token lands in any. */
function everythingStored(): string {
  const dump = (storage: Storage) =>
    Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index) ?? "";
      return `${key}=${storage.getItem(key)}`;
    }).join("\n");
  return `${dump(localStorage)}\n${dump(sessionStorage)}\n${document.cookie}`;
}

async function signedIn(h: Harness, returnTo = "/admin/members"): Promise<void> {
  await h.session.signIn(returnTo);
  const authorize = new URL(h.navigations.at(-1) ?? "");
  const state = authorize.searchParams.get("state") ?? "";
  await h.session.start({
    pathname: "/admin/auth/callback",
    search: `?code=the-code&state=${state}&iss=${encodeURIComponent(config.issuer)}`,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () =>
    tokenResponse({
      access_token: ACCESS,
      refresh_token: REFRESH,
      id_token: ID_TOKEN,
      expires_in: 300,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a page load", () => {
  it("tries a silent sign-in (prompt=none, PKCE S256, state) and stores only the transaction", async () => {
    const h = harness();
    await h.session.start({ pathname: "/admin/members/abc", search: "" });
    expect(h.session.getState()).toEqual({ status: "redirecting" });
    const url = new URL(h.navigations[0] ?? "");
    expect(url.origin + url.pathname).toBe(metadata.authorizationEndpoint);
    expect(url.searchParams.get("prompt")).toBe("none");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/admin/auth/callback`);
    expect(url.searchParams.get("client_id")).toBe("webflix-admin");
    const state = url.searchParams.get("state") ?? "";
    expect(state).toMatch(/^[\w-]{43}$/);
    const stored = JSON.parse(sessionStorage.getItem(`webflix-admin:signin:${state}`) ?? "{}");
    expect(stored.returnTo).toBe("/admin/members/abc");
    expect(stored.silent).toBe(true);
    expect(localStorage.length).toBe(0);
  });

  it("after signing out on purpose, shows signed out instead of signing straight back in", async () => {
    const h = harness();
    markSignedOut(h.now.value);
    await h.session.start({ pathname: "/admin/", search: "" });
    expect(h.session.getState()).toMatchObject({ status: "signed-out", reason: "signed-out" });
    expect(h.navigations).toEqual([]);
  });

  it("never returns to another origin or a protocol-relative path", async () => {
    const h = harness();
    for (const returnTo of ["//evil.example/x", "https://evil.example/", "/elsewhere"]) {
      await h.session.signIn(returnTo);
      const state = new URL(h.navigations.at(-1) ?? "").searchParams.get("state") ?? "";
      const stored = JSON.parse(sessionStorage.getItem(`webflix-admin:signin:${state}`) ?? "{}");
      expect(stored.returnTo).toBe("/admin/");
    }
  });
});

describe("the callback", () => {
  it("redeems the code with the verifier, drops the code from the URL, keeps tokens in memory only", async () => {
    const h = harness();
    await signedIn(h);
    expect(h.session.getState()).toEqual({ status: "signed-in" });
    expect(h.replaced).toEqual(["/admin/members"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(metadata.tokenEndpoint);
    expect(init.credentials).toBe("omit");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toMatch(/^[\w-]{43}$/);
    expect(await h.session.accessToken()).toBe(ACCESS);
    const stored = everythingStored();
    for (const secret of [ACCESS, REFRESH, ID_TOKEN, "the-code"])
      expect(stored).not.toContain(secret);
    // The transaction is single use.
    expect(sessionStorage.length).toBe(0);
  });

  it("refuses an unknown or replayed state without redeeming anything", async () => {
    const h = harness();
    await h.session.start({
      pathname: "/admin/auth/callback",
      search: "?code=x&state=not-a-state-we-sent",
    });
    expect(h.session.getState()).toMatchObject({ status: "signed-out", reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.replaced).toEqual(["/admin/"]);
  });

  it("refuses a response from another issuer (RFC 9207) before redeeming the code", async () => {
    const h = harness();
    await h.session.signIn("/admin/");
    const state = new URL(h.navigations[0] ?? "").searchParams.get("state") ?? "";
    await h.session.start({
      pathname: "/admin/auth/callback",
      search: `?code=x&state=${state}&iss=${encodeURIComponent("https://evil.example")}`,
    });
    expect(h.session.getState()).toMatchObject({ status: "signed-out", reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a refused silent sign-in into the sign-in page, never a loop", async () => {
    const h = harness();
    await h.session.signIn("/admin/plans", { silent: true });
    const state = new URL(h.navigations[0] ?? "").searchParams.get("state") ?? "";
    await h.session.start({
      pathname: "/admin/auth/callback",
      search: `?error=login_required&state=${state}`,
    });
    expect(h.session.getState()).toEqual({
      status: "signed-out",
      reason: "required",
      returnTo: "/admin/plans",
    });
    expect(h.navigations).toHaveLength(1);
  });

  it("says a cancelled sign-in was cancelled", async () => {
    const h = harness();
    await h.session.signIn("/admin/");
    const state = new URL(h.navigations[0] ?? "").searchParams.get("state") ?? "";
    await h.session.start({
      pathname: "/admin/auth/callback",
      search: `?error=access_denied&state=${state}`,
    });
    expect(h.session.getState()).toMatchObject({ status: "signed-out", reason: "cancelled" });
  });
});

describe("renewal", () => {
  it("renews a token near its end before using it, with the refresh token, rotating it", async () => {
    const h = harness();
    await signedIn(h);
    fetchMock.mockResolvedValueOnce(
      tokenResponse({
        access_token: "renewed.access.token",
        refresh_token: "refresh-2",
        expires_in: 300,
      }),
    );
    h.now.value += 290_000;
    expect(await h.session.accessToken()).toBe("renewed.access.token");
    const body = new URLSearchParams(
      String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body),
    );
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(REFRESH);
    expect(everythingStored()).not.toContain("renewed.access.token");
  });

  it("ends the session when the issuer refuses renewal", async () => {
    const h = harness();
    await signedIn(h);
    fetchMock.mockResolvedValueOnce(tokenResponse({ error: "invalid_grant" }, 400));
    expect(await h.session.renewAfterRefusal()).toBe(false);
    expect(h.session.getState()).toMatchObject({ status: "signed-out", reason: "expired" });
    expect(await h.session.accessToken()).toBe("");
  });

  it("stops renewing a tab nobody has used for 15 minutes, whatever refreshes in the background", async () => {
    const h = harness();
    await signedIn(h);
    const calls = fetchMock.mock.calls.length;
    h.now.value += 16 * 60_000;
    expect(await h.session.accessToken()).toBe("");
    expect(h.session.getState()).toMatchObject({ status: "signed-out", reason: "idle" });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("keeps renewing while someone uses the tab", async () => {
    const h = harness();
    await signedIn(h);
    h.now.value += 14 * 60_000;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    h.now.value += 2 * 60_000;
    fetchMock.mockResolvedValueOnce(
      tokenResponse({
        access_token: "still.here.token",
        refresh_token: "refresh-3",
        expires_in: 300,
      }),
    );
    expect(await h.session.accessToken()).toBe("still.here.token");
  });

  it("keeps a working token when the issuer is briefly unreachable", async () => {
    const h = harness();
    await signedIn(h);
    fetchMock.mockRejectedValueOnce(new TypeError("network"));
    expect(await h.session.renewAfterRefusal()).toBe(true);
    expect(h.session.getState()).toEqual({ status: "signed-in" });
  });
});

describe("sign-out", () => {
  it("forgets the tokens, tells the other tabs, and ends the issuer session", async () => {
    const h = harness();
    await signedIn(h);
    h.session.signOut();
    await vi.waitFor(() => expect(h.navigations.at(-1)).toContain("/logout"));
    const logout = new URL(h.navigations.at(-1) ?? "");
    expect(logout.searchParams.get("id_token_hint")).toBe(ID_TOKEN);
    expect(logout.searchParams.get("post_logout_redirect_uri")).toBe(`${ORIGIN}/admin/`);
    expect(h.posted).toEqual([{ type: "signed-out" }]);
    expect(await h.session.accessToken()).toBe("");
  });
});
