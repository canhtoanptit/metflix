/**
 * The state design and the guarantees the README's table states, configuration by
 * configuration: the default in-memory store, no store at all, a store shared by instances
 * (replicas or Workers isolates), and the sealing that holds whatever the store.
 */
import { describe, expect, it } from "vitest";
import { type DevIdpStore, MemoryDevIdpStore } from "../src/index.ts";
import {
  CookieJar,
  ManualClock,
  startTestIssuer,
  type TestIssuer,
  type TestIssuerOptions,
} from "../src/testing/index.ts";
import { authorizeUrl, freshCode, redeem, redirectParams, tokenRequest } from "./support/flows.ts";

const SHARED_SECRET = "a-development-sealing-secret-of-32+chars";

async function refreshOnce(t: TestIssuer, token: string) {
  return tokenRequest(t, { grant_type: "refresh_token", refresh_token: token });
}

async function signedIn(t: TestIssuer) {
  const { code, verifier, jar } = await freshCode(t, { scope: "openid offline_access" });
  return { code, verifier, jar, tokens: (await redeem(t, code, verifier)).body };
}

async function silent(t: TestIssuer, jar: CookieJar): Promise<boolean> {
  const { url } = await authorizeUrl(t, { prompt: "none" });
  const cookie = jar.header(url);
  const response = await t.fetch(new Request(url, { headers: cookie ? { Cookie: cookie } : {} }));
  return redirectParams(response).has("code");
}

/** A second browser holding a copy of the first one's issuer session cookie. */
function copySession(jar: CookieJar, issuer: string): CookieJar {
  const cookie = (jar.header(new URL(`${issuer}/authorize`)) ?? "")
    .split("; ")
    .find((pair) => pair.includes("_session="));
  if (!cookie) throw new Error("No session cookie to copy");
  const copy = new CookieJar();
  copy.store(issuer, new Response(null, { headers: [["Set-Cookie", `${cookie}; Path=/`]] }));
  return copy;
}

describe("MemoryDevIdpStore", () => {
  it("claims atomically and expires", async () => {
    const clock = new ManualClock();
    const store = new MemoryDevIdpStore({ clock });
    const results = await Promise.all([
      store.claim("k", clock.now() + 1000),
      store.claim("k", clock.now() + 1000),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await store.has("k")).toBe(true);
    clock.advance(1000);
    expect(await store.has("k")).toBe(false);
    expect(await store.claim("k", clock.now() + 1000)).toBe(true);
    for (let index = 0; index < 300; index += 1) await store.claim(`x${index}`, clock.now() + 10);
    clock.advance(20);
    await store.claim("later", clock.now() + 10_000);
    expect(store.size).toBe(2);
  });
});

describe("default configuration (in-memory store): strict within one process", () => {
  it("codes are single use", async () => {
    const t = startTestIssuer();
    const { code, verifier } = await signedIn(t);
    expect((await redeem(t, code, verifier)).body.error).toBe("invalid_grant");
  });

  it("refresh reuse revokes the family", async () => {
    const t = startTestIssuer();
    const { tokens } = await signedIn(t);
    const next = await refreshOnce(t, tokens.refresh_token as string);
    expect((await refreshOnce(t, tokens.refresh_token as string)).body.error).toBe("invalid_grant");
    expect((await refreshOnce(t, next.body.refresh_token as string)).body.error).toBe(
      "invalid_grant",
    );
  });

  it("logout revokes the session even for a copied cookie", async () => {
    const t = startTestIssuer();
    const { jar, tokens } = await signedIn(t);
    const copy = copySession(jar, t.issuer);
    expect(await silent(t, copy)).toBe(true);
    const cookie = jar.header(new URL(`${t.issuer}/logout`)) ?? "";
    await t.fetch(
      new Request(`${t.issuer}/logout?id_token_hint=${tokens.id_token as string}`, {
        headers: { Cookie: cookie },
      }),
    );
    expect(await silent(t, copy)).toBe(false);
  });
});

describe('store: "none" (stateless): what still holds and what does not', () => {
  const stateless: TestIssuerOptions = { store: "none" };

  it("a code can be redeemed again within its lifetime, never after", async () => {
    const t = startTestIssuer(stateless);
    const { code, verifier } = await signedIn(t);
    expect((await redeem(t, code, verifier)).status).toBe(200);
    t.clock.advance(61_000);
    expect((await redeem(t, code, verifier)).body.error).toBe("invalid_grant");
  });

  it("rotated-out refresh tokens keep working until they expire", async () => {
    const t = startTestIssuer(stateless);
    const { tokens } = await signedIn(t);
    expect((await refreshOnce(t, tokens.refresh_token as string)).status).toBe(200);
    expect((await refreshOnce(t, tokens.refresh_token as string)).status).toBe(200);
  });

  it("logout clears the cookie, but a copied cookie still signs in until it expires", async () => {
    const t = startTestIssuer(stateless);
    const { jar, tokens } = await signedIn(t);
    const copy = copySession(jar, t.issuer);
    const cookie = jar.header(new URL(`${t.issuer}/logout`)) ?? "";
    await t.fetch(
      new Request(`${t.issuer}/logout?id_token_hint=${tokens.id_token as string}`, {
        headers: { Cookie: cookie },
      }),
    );
    expect(await silent(t, copy)).toBe(true);
    t.clock.advance(12 * 3600 * 1000);
    expect(await silent(t, copy)).toBe(false);
  });

  it("every binding still holds: client, redirect URI, PKCE, expiry, integrity", async () => {
    const t = startTestIssuer(stateless);
    const { code, verifier } = await freshCode(t);
    expect((await redeem(t, code, `${"x".repeat(43)}`)).body.error).toBe("invalid_grant");
    expect(
      (await redeem(t, code, verifier, { redirect_uri: "https://rp.test/x" })).body.error,
    ).toBe("invalid_grant");
    expect(
      (
        await redeem(
          t,
          code,
          verifier,
          { client_id: "confidential-post", client_secret: "confidential-post-secret" },
          {},
        )
      ).body.error,
    ).toBe("invalid_grant");
    expect((await redeem(t, code, verifier)).status).toBe(200);
  });
});

describe("several instances (replicas, Workers isolates)", () => {
  function pair(store: DevIdpStore | "memory", secret: string | undefined = SHARED_SECRET) {
    const clock = new ManualClock();
    const a = startTestIssuer({ clock, secret, store });
    const b = startTestIssuer({ clock, secret, store });
    return { a, b };
  }

  it("with a shared secret, any instance redeems a code another minted", async () => {
    const { a, b } = pair("memory");
    const { code, verifier } = await freshCode(a);
    expect((await redeem(b, code, verifier)).status).toBe(200);
  });

  it("with a shared store, single use holds across instances", async () => {
    const shared = new MemoryDevIdpStore();
    const { a, b } = pair(shared);
    const { code, verifier } = await freshCode(a);
    expect((await redeem(b, code, verifier)).status).toBe(200);
    expect((await redeem(a, code, verifier)).body.error).toBe("invalid_grant");
  });

  it("with a store per instance, a replay on another instance is NOT detected (the documented limit)", async () => {
    const { a, b } = pair("memory");
    const { code, verifier } = await freshCode(a);
    expect((await redeem(a, code, verifier)).status).toBe(200);
    expect((await redeem(b, code, verifier)).status).toBe(200);
  });

  it("without a shared secret, instances refuse each other's codes (fail closed)", async () => {
    const clock = new ManualClock();
    const a = startTestIssuer({ clock });
    const b = startTestIssuer({ clock });
    const { code, verifier } = await freshCode(a);
    expect((await redeem(b, code, verifier)).body.error).toBe("invalid_grant");
  });
});

describe("sealing: integrity and separation, whatever the store", () => {
  it("a tampered code, a session cookie used as a code, and a code of another issuer are refused", async () => {
    const clock = new ManualClock();
    const a = startTestIssuer({ clock, secret: SHARED_SECRET, store: "none" });
    const other = startTestIssuer({
      clock,
      secret: SHARED_SECRET,
      store: "none",
      issuer: "https://other.test",
    });
    const { code, verifier, jar } = await freshCode(a);
    const tampered = `${code.slice(0, 40)}${code[40] === "A" ? "B" : "A"}${code.slice(41)}`;
    expect((await redeem(a, tampered, verifier)).body.error).toBe("invalid_grant");
    const session =
      (jar.header(new URL(`${a.issuer}/authorize`)) ?? "")
        .split("; ")
        .find((c) => c.includes("_session="))
        ?.split("=")[1] ?? "";
    expect(session.length).toBeGreaterThan(50);
    expect((await redeem(a, session, verifier)).body.error).toBe("invalid_grant");
    expect((await redeem(other, code, verifier)).body.error).toBe("invalid_grant");
    expect((await redeem(a, code, verifier)).status).toBe(200);
  });
});
