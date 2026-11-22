/** The authorisation endpoint and the sign-in page: validation, redirects, sessions, page security. */
import { describe, expect, it } from "vitest";
import {
  CookieJar,
  startTestIssuer,
  TEST_REDIRECT_URI,
  type TestIssuer,
} from "../src/testing/index.ts";
import {
  authorizeUrl,
  decodeJwt,
  openPicker,
  redeem,
  redirectParams,
  submitPicker,
} from "./support/flows.ts";

async function get(t: TestIssuer, url: URL, jar?: CookieJar): Promise<Response> {
  const cookie = jar?.header(url);
  const response = await t.fetch(new Request(url, { headers: cookie ? { Cookie: cookie } : {} }));
  jar?.store(url, response);
  return response;
}

describe("requests that cannot be trusted are shown, never redirected", () => {
  const cases: Array<[string, Record<string, string | undefined>]> = [
    ["missing client_id", { client_id: undefined }],
    ["unknown client_id", { client_id: "nobody" }],
    ["missing redirect_uri", { redirect_uri: undefined }],
    ["a redirect_uri with a trailing slash", { redirect_uri: `${TEST_REDIRECT_URI}/` }],
    ["a redirect_uri with another case", { redirect_uri: "https://RP.test/callback" }],
    ["a redirect_uri with a query added", { redirect_uri: `${TEST_REDIRECT_URI}?next=/` }],
    ["a redirect_uri with a fragment", { redirect_uri: `${TEST_REDIRECT_URI}#x` }],
    ["a redirect_uri over http", { redirect_uri: "http://rp.test/callback" }],
    ["a redirect_uri prefix", { redirect_uri: "https://rp.test/callback/../evil" }],
    ["another host", { redirect_uri: "https://evil.test/callback" }],
    ["a userinfo trick", { redirect_uri: "https://rp.test@evil.test/callback" }],
  ];
  for (const [label, params] of cases) {
    it(label, async () => {
      const t = startTestIssuer();
      const { url } = await authorizeUrl(t, params);
      const response = await get(t, url);
      expect(response.status).toBe(400);
      expect(response.headers.get("Location")).toBeNull();
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    });
  }

  it("escapes what it echoes", async () => {
    const t = startTestIssuer();
    const { url } = await authorizeUrl(t, { client_id: '<script>alert("x")</script>' });
    const html = await (await get(t, url)).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("a repeated client_id or redirect_uri", async () => {
    const t = startTestIssuer();
    const { url } = await authorizeUrl(t);
    url.searchParams.append("redirect_uri", "https://evil.test/");
    const response = await get(t, url);
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });
});

describe("invalid requests from a known client go back to it with an error", () => {
  const cases: Array<[string, Record<string, string | undefined>, string, string?]> = [
    ["missing response_type", { response_type: undefined }, "invalid_request"],
    ["implicit flow", { response_type: "token" }, "unsupported_response_type"],
    ["hybrid flow", { response_type: "code id_token" }, "unsupported_response_type"],
    ["fragment response mode", { response_mode: "fragment" }, "invalid_request"],
    ["missing scope", { scope: undefined }, "invalid_scope"],
    ["no openid scope", { scope: "email" }, "invalid_scope"],
    ["an unknown scope", { scope: "openid admin" }, "invalid_scope"],
    ["missing state", { state: undefined }, "invalid_request"],
    ["a huge state", { state: "s".repeat(2049) }, "invalid_request"],
    ["missing nonce", { nonce: undefined }, "invalid_request"],
    [
      "missing PKCE",
      { code_challenge: undefined, code_challenge_method: undefined },
      "invalid_request",
    ],
    ["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"],
    [
      "PKCE without a method (plain by default)",
      { code_challenge_method: undefined },
      "invalid_request",
    ],
    ["a method without a challenge", { code_challenge: undefined }, "invalid_request"],
    ["a malformed challenge", { code_challenge: "short" }, "invalid_request"],
    ["an unknown prompt", { prompt: "create" }, "invalid_request"],
    ["prompt=none with login", { prompt: "none login" }, "invalid_request"],
    ["a negative max_age", { max_age: "-1" }, "invalid_request"],
    ["a request object", { request: "eyJ..." }, "request_not_supported"],
    ["a request_uri", { request_uri: "https://rp.test/r" }, "request_uri_not_supported"],
    ["registration", { registration: "{}" }, "registration_not_supported"],
  ];
  for (const [label, params, error] of cases) {
    it(label, async () => {
      const t = startTestIssuer();
      const { url } = await authorizeUrl(t, params);
      const response = await get(t, url);
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location") ?? "");
      expect(`${location.origin}${location.pathname}`).toBe(TEST_REDIRECT_URI);
      expect(location.searchParams.get("error")).toBe(error);
      expect(location.searchParams.get("iss")).toBe(t.issuer);
      if (params.state === undefined && !("state" in params)) {
        expect(location.searchParams.get("state")).toBe("state-123");
      }
    });
  }

  it("a repeated parameter (after the client is known)", async () => {
    const t = startTestIssuer();
    const { url } = await authorizeUrl(t);
    url.searchParams.append("scope", "openid");
    expect(redirectParams(await get(t, url)).get("error")).toBe("invalid_request");
  });

  it("errors use form_post when the request asked for it", async () => {
    const t = startTestIssuer();
    const { url } = await authorizeUrl(t, { response_mode: "form_post", scope: "openid admin" });
    const response = await get(t, url);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`action="${TEST_REDIRECT_URI}"`);
    expect(html).toContain('name="error" value="invalid_scope"');
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "form-action https://rp.test",
    );
  });

  it("a public client may not skip PKCE even if a confidential one could", async () => {
    const t = startTestIssuer({
      clients: [
        { clientId: "public-spa", redirectUris: [TEST_REDIRECT_URI] },
        {
          clientId: "relaxed",
          clientSecret: "relaxed-client-secret",
          requirePkce: false,
          requireState: false,
          requireNonce: false,
          redirectUris: [TEST_REDIRECT_URI],
        },
      ],
    });
    const pub = await authorizeUrl(t, {
      client_id: "public-spa",
      code_challenge: undefined,
      code_challenge_method: undefined,
    });
    expect(redirectParams(await get(t, pub.url)).get("error")).toBe("invalid_request");
    const relaxed = await authorizeUrl(t, {
      client_id: "relaxed",
      code_challenge: undefined,
      code_challenge_method: undefined,
      state: undefined,
      nonce: undefined,
    });
    expect((await get(t, relaxed.url)).status).toBe(200);
  });
});

describe("the sign-in page", () => {
  it("is labelled, self-contained and locked down", async () => {
    const t = startTestIssuer();
    const { url } = await authorizeUrl(t);
    const { response, html } = await openPicker(t, url);
    expect(html).toContain("<h1>Development sign-in</h1>");
    expect(html).toContain("DEVELOPMENT ONLY");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('name="viewport"');
    // No external assets of any kind.
    expect(html).not.toMatch(/\b(?:src|href)=/);
    expect(html).not.toMatch(/url\(/);
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/style-src 'nonce-[A-Za-z0-9_-]+'/);
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("form-action https://dev-idp.test https://rp.test");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("is accessible: every control is labelled, one main landmark, one h1", async () => {
    const t = startTestIssuer();
    const { url } = await authorizeUrl(t);
    const { html } = await openPicker(t, url);
    expect(html.match(/<main>/g)).toHaveLength(1);
    expect(html.match(/<h1>/g)).toHaveLength(1);
    const ids = [...html.matchAll(/<input (?![^>]*type="hidden")[^>]*id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) expect(html).toContain(`for="${id}"`);
    for (const fieldset of html.match(/<fieldset[^>]*>/g) ?? []) expect(fieldset).toBeTruthy();
    expect(html.match(/<fieldset/g)?.length).toBe(html.match(/<legend>/g)?.length);
    // Checkbox labels wrap their input (implicitly labelled).
    for (const checkbox of html.match(/<label class="check"><input type="checkbox"/g) ?? [])
      expect(checkbox).toBeTruthy();
    expect(html).toMatch(
      /<button type="submit" class="primary" name="action" value="continue">Continue<\/button>/,
    );
  });

  it("sets a Lax, HttpOnly CSRF cookie scoped to the issuer, reused across tabs", async () => {
    const t = startTestIssuer({ issuer: "https://dev-idp.test/realms/a" });
    const { url } = await authorizeUrl(t);
    const first = await openPicker(t, url);
    const cookie = first.response.headers.getSetCookie()[0] ?? "";
    expect(cookie).toMatch(
      /^__Secure-devidp_[a-z0-9]+_csrf=[A-Za-z0-9_-]+; Path=\/realms\/a; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/,
    );
    const second = await openPicker(t, url, first.jar);
    expect(second.response.headers.getSetCookie()).toEqual([]);
    // Both tabs can submit.
    expect((await submitPicker(t, first, { persona: "new-member" })).status).toBe(303);
    expect((await submitPicker(t, second, { persona: "new-member" })).status).toBe(303);
  });

  it("refuses a submission without the browser's CSRF cookie, from another site, or with a forged transaction", async () => {
    const t = startTestIssuer();
    const { url } = await authorizeUrl(t);
    const picker = await openPicker(t, url);
    expect(
      (await submitPicker(t, picker, { persona: "new-member" }, { cookie: null })).status,
    ).toBe(403);
    const otherBrowser = await openPicker(t, url);
    const foreignCookie = otherBrowser.jar.header(otherBrowser.action) ?? "";
    expect(
      (await submitPicker(t, picker, { persona: "new-member" }, { cookie: foreignCookie })).status,
    ).toBe(403);
    expect(
      (
        await submitPicker(
          t,
          picker,
          { persona: "new-member" },
          { headers: { "Sec-Fetch-Site": "cross-site" } },
        )
      ).status,
    ).toBe(403);
    // Flip one character in the middle (the last may only carry padding bits).
    const forged = `${picker.txn.slice(0, 20)}${picker.txn[20] === "A" ? "B" : "A"}${picker.txn.slice(21)}`;
    expect((await submitPicker(t, picker, { persona: "new-member", txn: forged })).status).toBe(
      400,
    );
  });

  it("expires after the transaction lifetime", async () => {
    const t = startTestIssuer();
    const { url } = await authorizeUrl(t);
    const picker = await openPicker(t, url);
    t.clock.advance(601_000);
    const response = await submitPicker(t, picker, { persona: "new-member" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("expired");
  });

  it("refuses unknown personas, unknown faults and repeated fields; re-asks for an invalid email", async () => {
    const t = startTestIssuer();
    const { url } = await authorizeUrl(t);
    const picker = await openPicker(t, url);
    expect((await submitPicker(t, picker, { persona: "nobody" })).status).toBe(400);
    expect(
      (await submitPicker(t, picker, { persona: "new-member", fault: "jwksSlow" })).status,
    ).toBe(400);
    expect((await submitPicker(t, picker, { persona: "new-member", fault: "nope" })).status).toBe(
      400,
    );
    expect((await submitPicker(t, picker, { persona: ["new-member", "no-email"] })).status).toBe(
      400,
    );
    const invalid = await submitPicker(t, picker, {
      persona: "__email__",
      email: "<b>not an email",
    });
    expect(invalid.status).toBe(400);
    const html = await invalid.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Development sign-in");
  });

  it("Cancel returns access_denied", async () => {
    const t = startTestIssuer();
    const { url } = await authorizeUrl(t);
    const picker = await openPicker(t, url);
    const params = redirectParams(await submitPicker(t, picker, { action: "cancel" }));
    expect(params.get("error")).toBe("access_denied");
    expect(params.get("state")).toBe("state-123");
    expect(params.get("code")).toBeNull();
  });

  it("mints a persona from a typed email, stable per address", async () => {
    const t = startTestIssuer();
    const subs: unknown[] = [];
    for (const email of ["Jo.Smith@Example.com", "jo.smith@example.com"]) {
      const { url, verifier } = await authorizeUrl(t);
      const picker = await openPicker(t, url);
      const params = redirectParams(
        await submitPicker(t, picker, {
          persona: "__email__",
          email,
          name: "  Jo\u0007 Smith ",
          email_verified: "true",
        }),
      );
      const { body } = await redeem(t, params.get("code") ?? "", verifier);
      const { claims } = decodeJwt(body.id_token as string);
      expect(claims.name).toBe("Jo Smith");
      expect(claims.email_verified).toBe(true);
      subs.push(claims.sub);
    }
    expect(subs[0]).toBe(subs[1]);
    const { url, verifier } = await authorizeUrl(t);
    const picker = await openPicker(t, url);
    const params = redirectParams(
      await submitPicker(t, picker, { persona: "__email__", email: "unverified@example.com" }),
    );
    const { claims } = decodeJwt(
      (await redeem(t, params.get("code") ?? "", verifier)).body.id_token as string,
    );
    expect(claims.email_verified).toBe(false);
    expect(claims.name).toBe("Unverified");
  });

  it("login_hint preselects a persona, or prefills an unknown address", async () => {
    const t = startTestIssuer();
    const byEmail = await openPicker(
      t,
      (await authorizeUrl(t, { login_hint: "sam.rivera@example.com" })).url,
    );
    expect(byEmail.html).toMatch(/value="renamed" checked/);
    const unknown = await openPicker(
      t,
      (await authorizeUrl(t, { login_hint: "new.person@example.com" })).url,
    );
    expect(unknown.html).toMatch(/value="__email__" checked/);
    expect(unknown.html).toContain('value="new.person@example.com"');
  });
});

describe("the authorisation response", () => {
  it("carries code, state and iss (RFC 9207), keeping a registered query string", async () => {
    const registered = "https://rp.test/callback?tenant=a&x=%20";
    const t = startTestIssuer({
      clients: [
        {
          clientId: "confidential-basic",
          clientSecret: "confidential-basic-secret",
          redirectUris: [registered],
        },
      ],
    });
    const { url } = await authorizeUrl(t, { redirect_uri: registered });
    const picker = await openPicker(t, url);
    const response = await submitPicker(t, picker, { persona: "new-member" });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.searchParams.get("tenant")).toBe("a");
    expect(location.searchParams.get("x")).toBe(" ");
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(location.searchParams.get("iss")).toBe(t.issuer);
    expect(location.searchParams.get("code")?.length).toBeGreaterThan(100);
  });

  it("form_post: an auto-submitting page with a script nonce, escaping every value", async () => {
    const t = startTestIssuer();
    const state = `"><script>alert(1)</script>`;
    const { url } = await authorizeUrl(t, { response_mode: "form_post", state });
    const picker = await openPicker(t, url);
    const response = await submitPicker(t, picker, { persona: "new-member" });
    expect(response.status).toBe(200);
    const html = await response.text();
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("form-action https://rp.test");
    expect(html).toContain(
      `<script nonce="${nonce}">document.getElementById("form-post").submit();</script>`,
    );
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).toContain("<noscript>");
  });

  it("the authorization endpoint accepts POST too (OpenID Connect Core §3.1.2.1)", async () => {
    const t = startTestIssuer();
    const { url } = await authorizeUrl(t);
    const response = await t.fetch(
      new Request(`${t.issuer}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: url.searchParams.toString(),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Development sign-in");
  });
});

describe("sessions: prompt, max_age, login_hint", () => {
  async function signedInJar(t: TestIssuer, persona = "new-member"): Promise<CookieJar> {
    const jar = new CookieJar();
    const { url } = await authorizeUrl(t);
    await t.completeAuthorization(url, { persona }, jar);
    return jar;
  }

  it("sets a Lax, HttpOnly session cookie scoped to the issuer path", async () => {
    const t = startTestIssuer({ issuer: "http://localhost:5450/dev-idp/google" });
    const { url } = await authorizeUrl(t);
    const picker = await openPicker(t, url);
    const response = await submitPicker(t, picker, { persona: "new-member" });
    const session = response.headers.getSetCookie().find((cookie) => cookie.includes("_session="));
    expect(session).toMatch(
      /^devidp_[a-z0-9]+_session=[A-Za-z0-9_-]+; Path=\/dev-idp\/google; Max-Age=43200; HttpOnly; SameSite=Lax$/,
    );
  });

  it("signs in silently with a session; prompt=login and select_account show the page", async () => {
    const t = startTestIssuer();
    const jar = await signedInJar(t);
    const silent = await get(t, (await authorizeUrl(t)).url, jar);
    expect(silent.status).toBe(302);
    expect(redirectParams(silent).get("code")).toBeTruthy();
    expect((await get(t, (await authorizeUrl(t, { prompt: "login" })).url, jar)).status).toBe(200);
    const select = await get(t, (await authorizeUrl(t, { prompt: "select_account" })).url, jar);
    expect(select.status).toBe(200);
    expect(await select.text()).toContain("signed in");
  });

  it("prompt=none: login_required without a session, too old a session, or another account hinted", async () => {
    const t = startTestIssuer();
    const none = await get(t, (await authorizeUrl(t, { prompt: "none" })).url);
    expect(redirectParams(none).get("error")).toBe("login_required");
    const jar = await signedInJar(t);
    expect(
      redirectParams(await get(t, (await authorizeUrl(t, { prompt: "none" })).url, jar)).get(
        "code",
      ),
    ).toBeTruthy();
    t.clock.advance(301_000);
    const old = await get(t, (await authorizeUrl(t, { prompt: "none", max_age: "300" })).url, jar);
    expect(redirectParams(old).get("error")).toBe("login_required");
    const other = await get(
      t,
      (await authorizeUrl(t, { prompt: "none", login_hint: "demo@webflix.dev" })).url,
      jar,
    );
    expect(redirectParams(other).get("error")).toBe("login_required");
    const same = await get(
      t,
      (await authorizeUrl(t, { prompt: "none", login_hint: "riley.chen@example.com" })).url,
      jar,
    );
    expect(redirectParams(same).get("code")).toBeTruthy();
  });

  it("re-authentication refreshes auth_time; continuing the session keeps it", async () => {
    const t = startTestIssuer();
    const jar = new CookieJar();
    const first = await authorizeUrl(t);
    const outcome = await t.completeAuthorization(first.url, { persona: "new-member" }, jar);
    const authTime = decodeJwt(
      (await redeem(t, outcome.code ?? "", first.verifier)).body.id_token as string,
    ).claims.auth_time;
    t.clock.advance(90_000);
    const select = await authorizeUrl(t, { prompt: "select_account" });
    const kept = await t.completeAuthorization(select.url, { persona: "new-member" }, jar);
    expect(
      decodeJwt((await redeem(t, kept.code ?? "", select.verifier)).body.id_token as string).claims
        .auth_time,
    ).toBe(authTime);
    const login = await authorizeUrl(t, { prompt: "login" });
    const fresh = await t.completeAuthorization(login.url, { persona: "new-member" }, jar);
    expect(
      decodeJwt((await redeem(t, fresh.code ?? "", login.verifier)).body.id_token as string).claims
        .auth_time,
    ).toBe(Math.floor(t.clock.now() / 1000));
  });

  it("a session cookie from another issuer or forged is ignored", async () => {
    const a = startTestIssuer();
    const b = startTestIssuer();
    const jar = await signedInJar(a);
    const response = await get(b, (await authorizeUrl(b, { prompt: "none" })).url, jar);
    expect(redirectParams(response).get("error")).toBe("login_required");
  });
});
