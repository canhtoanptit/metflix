/**
 * Every fault in the catalogue: the provider produces it (asserted on the raw artefact) and the
 * independent relying party rejects it with the rule the README names. Flow faults are injected
 * through the sign-in page's own form field, as a person testing by hand would; endpoint faults
 * through `idp.faults.set`.
 */
import { describe, expect, it } from "vitest";
import { DEVELOPMENT_RETIRED_KEYS, DEVELOPMENT_UNPUBLISHED_KEYS } from "../src/development-keys.ts";
import { FAULT_CATALOGUE, FAULT_NAMES, type FaultName } from "../src/index.ts";
import { startTestIssuer, TEST_REDIRECT_URI, type TestIssuer } from "../src/testing/index.ts";
import {
  IndependentRp,
  RpError,
  type SignInResult,
  signInWith,
  UserAgent,
} from "./support/independent-rp.ts";

type Json = Record<string, unknown>;

function decode(token: string): { header: Json; claims: Json; signature: string } {
  const [h = "", c = "", s = ""] = token.split(".");
  const json = (part: string) =>
    JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as Json;
  return { header: json(h), claims: json(c), signature: s };
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "===".slice((base64.length + 3) % 4)), (c) =>
    c.charCodeAt(0),
  );
}

async function verifiesWith(token: string, jwk: Json): Promise<boolean> {
  const [h = "", c = "", s = ""] = token.split(".");
  const ec = jwk.kty === "EC";
  const { kty, n, e, crv, x, y } = jwk as Record<string, string>;
  const key = await crypto.subtle.importKey(
    "jwk",
    ec ? { kty, crv, x, y } : { kty, n, e },
    ec ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    ec ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" },
    key,
    b64urlBytes(s),
    new TextEncoder().encode(`${h}.${c}`),
  );
}

interface Harness {
  t: TestIssuer;
  rp: IndependentRp;
  /** A new browser each time: flow faults are ticked on the sign-in page, which a session skips. */
  agent: () => UserAgent;
  persona: string;
  jwksFetches: () => number;
}

function harness(
  options: { profile?: "generic" | "keycloak"; clientId?: string; jwksTimeoutMs?: number } = {},
): Harness {
  const t = startTestIssuer({ profile: options.profile ?? "generic" });
  let jwksFetches = 0;
  const fetch = (request: Request) => {
    if (new URL(request.url).pathname === "/jwks") jwksFetches += 1;
    return t.fetch(request);
  };
  const clientId = options.clientId ?? "confidential-basic";
  const rp = new IndependentRp({
    issuer: t.issuer,
    clientId,
    redirectUri: TEST_REDIRECT_URI,
    auth:
      clientId === "public-spa"
        ? { method: "none" }
        : { method: "client_secret_basic", secret: "confidential-basic-secret" },
    fetch,
    now: () => t.clock.now(),
    jwksTimeoutMs: options.jwksTimeoutMs ?? 2000,
  });
  return {
    t,
    rp,
    agent: () => new UserAgent(fetch),
    persona: options.profile === "keycloak" ? "staff-admin" : "new-member",
    jwksFetches: () => jwksFetches,
  };
}

/** Signs in with the faults ticked on the page; returns the RP's rule that refused it. */
async function attempt(
  h: Harness,
  faults: string[],
  options: { maxAge?: number; persona?: string } = {},
): Promise<{ code: string; result?: SignInResult }> {
  try {
    const result = await signInWith(
      h.rp,
      h.agent(),
      { persona: options.persona ?? h.persona, faults },
      {
        scope: "openid email profile",
        maxAge: options.maxAge,
      },
    );
    return { code: "accepted", result };
  } catch (error) {
    if (error instanceof RpError) return { code: error.code };
    throw error;
  }
}

/** The raw token response of a flow, bypassing the RP's validation (to inspect what was sent). */
async function raw(h: Harness, faults: string[], options: { maxAge?: number } = {}): Promise<Json> {
  const { url, transaction } = await h.rp.begin({
    scope: "openid email profile",
    maxAge: options.maxAge,
  });
  const delivered = await h.agent().authorize(url, { persona: h.persona, faults });
  const response = await h.t.fetch(
    new Request(`${h.t.issuer}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa("confidential-basic:confidential-basic-secret")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: delivered.params.get("code") ?? "",
        redirect_uri: TEST_REDIRECT_URI,
        code_verifier: transaction.verifier,
      }),
    }),
  );
  return (await response.json()) as Json;
}

async function publishedKids(h: Harness): Promise<string[]> {
  const response = await h.t.fetch(new Request(`${h.t.issuer}/jwks`));
  return ((await response.json()) as { keys: Array<{ kid: string }> }).keys.map((key) => key.kid);
}

const covered = new Set<FaultName>();
function fault(name: FaultName, body: () => Promise<void>) {
  covered.add(name);
  it(`${name}: ${FAULT_CATALOGUE[name].label}`, body);
}

describe("control", () => {
  it("the same flow without a fault is accepted", async () => {
    const h = harness();
    expect((await attempt(h, [])).code).toBe("accepted");
  });
});

describe("signature faults", () => {
  fault("unknownKey", async () => {
    const h = harness();
    const token = (await raw(h, ["unknownKey"])).id_token as string;
    const { header } = decode(token);
    expect(await publishedKids(h)).not.toContain(header.kid);
    const key = DEVELOPMENT_UNPUBLISHED_KEYS.find((candidate) => candidate.kid === header.kid);
    expect(key && (await verifiesWith(token, key))).toBe(true);
    expect((await attempt(harness(), ["unknownKey"])).code).toBe("unknown_kid");
  });

  fault("removedKey", async () => {
    const h = harness();
    const token = (await raw(h, ["removedKey"])).id_token as string;
    const { header } = decode(token);
    expect(await publishedKids(h)).not.toContain(header.kid);
    const key = DEVELOPMENT_RETIRED_KEYS.find((candidate) => candidate.kid === header.kid);
    expect(key && (await verifiesWith(token, key))).toBe(true);
    expect((await attempt(harness(), ["removedKey"])).code).toBe("unknown_kid");
  });

  fault("algNone", async () => {
    const h = harness();
    const token = (await raw(h, ["algNone"])).id_token as string;
    expect(decode(token).header.alg).toBe("none");
    expect(token.endsWith(".")).toBe(true);
    expect((await attempt(harness(), ["algNone"])).code).toBe("alg_not_allowed");
  });

  fault("hmacKeyConfusion", async () => {
    const h = harness();
    const token = (await raw(h, ["hmacKeyConfusion"])).id_token as string;
    const { header } = decode(token);
    expect(header.alg).toBe("HS256");
    // The MAC really is keyed with the published public key's PEM: a library that takes the
    // algorithm from the header and the "key" from the JWKS would accept this token.
    const jwks = (await (await h.t.fetch(new Request(`${h.t.issuer}/jwks`))).json()) as {
      keys: Json[];
    };
    const published = jwks.keys.find((key) => key.kid === header.kid) as Record<string, string>;
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: published.kty ?? "", n: published.n ?? "", e: published.e ?? "" },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true,
      ["verify"],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
    const pem = `-----BEGIN PUBLIC KEY-----\n${(btoa(String.fromCharCode(...der)).match(/.{1,64}/g) ?? []).join("\n")}\n-----END PUBLIC KEY-----\n`;
    const hmac = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(pem),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const [h64 = "", c64 = "", s64 = ""] = token.split(".");
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`${h64}.${c64}`)),
    );
    expect(b64url(mac)).toBe(s64);
    expect((await attempt(harness(), ["hmacKeyConfusion"])).code).toBe("alg_not_allowed");
  });

  fault("embeddedJwk", async () => {
    const h = harness();
    const token = (await raw(h, ["embeddedJwk"])).id_token as string;
    const { header } = decode(token);
    expect(header.jwk).toBeDefined();
    expect(await verifiesWith(token, header.jwk as Json)).toBe(true);
    expect((await attempt(harness(), ["embeddedJwk"])).code).toBe("unknown_kid");
  });
});

describe("claim faults", () => {
  const cases: Array<
    [FaultName, string, (claims: Json, now: number) => void, { maxAge?: number }?]
  > = [
    ["wrongIssuer", "iss_mismatch", (c) => expect(c.iss).toBe("https://dev-idp.test-mixup")],
    ["wrongAudience", "aud_mismatch", (c) => expect(c.aud).not.toBe("confidential-basic")],
    [
      "extraAudience",
      "untrusted_audience",
      (c) => {
        expect(c.aud).toEqual(["confidential-basic", "confidential-post"]);
        expect(c.azp).toBe("confidential-basic");
      },
    ],
    ["expired", "expired", (c, now) => expect(c.exp).toBeLessThanOrEqual(now - 600)],
    [
      "notYetValid",
      "issued_in_future",
      (c, now) => {
        expect(c.iat).toBeGreaterThanOrEqual(now + 600);
        expect(c.nbf).toBeGreaterThanOrEqual(now + 600);
      },
    ],
    ["wrongNonce", "nonce_mismatch", (c) => expect(typeof c.nonce).toBe("string")],
    ["missingNonce", "nonce_missing", (c) => expect(c.nonce).toBeUndefined()],
    ["wrongAtHash", "at_hash_mismatch", (c) => expect(typeof c.at_hash).toBe("string")],
    [
      "staleAuthTime",
      "auth_too_old",
      (c, now) => expect(c.auth_time).toBeLessThanOrEqual(now - 86_400),
      { maxAge: 300 },
    ],
    [
      "missingAuthTime",
      "auth_time_missing",
      (c) => expect(c.auth_time).toBeUndefined(),
      { maxAge: 300 },
    ],
  ];
  for (const [name, rule, check, options] of cases) {
    fault(name, async () => {
      const h = harness();
      const response = await raw(h, [name], options);
      const token = response.id_token as string;
      // Correctly signed: only the claim is wrong.
      const jwks = (await (await h.t.fetch(new Request(`${h.t.issuer}/jwks`))).json()) as {
        keys: Json[];
      };
      const key = jwks.keys.find((candidate) => candidate.kid === decode(token).header.kid);
      expect(key && (await verifiesWith(token, key))).toBe(true);
      check(decode(token).claims, Math.floor(h.t.clock.now() / 1000));
      expect((await attempt(harness(), [name], options)).code).toBe(rule);
    });
  }

  it("token faults can target the access token (a resource server must reject it)", async () => {
    for (const [name, rule] of [
      ["expired", "expired"],
      ["algNone", "alg_not_allowed"],
      ["wrongIssuer", "iss_mismatch"],
      ["unknownKey", "unknown_kid"],
    ] as const) {
      const h = harness({ profile: "keycloak", clientId: "public-spa" });
      const signedIn = await attempt(h, [`${name}:access_token`]);
      expect(signedIn.code).toBe("accepted");
      const error = await h.rp
        .validateAccessToken(signedIn.result?.accessToken ?? "", "test-api", "keycloak")
        .then(
          () => "accepted",
          (e: RpError) => e.code,
        );
      expect(error).toBe(rule);
    }
  });
});

describe("identity faults (accepted by token validation; the account rules must catch them)", () => {
  fault("emailUnverified", async () => {
    const h = harness();
    const { code, result } = await attempt(h, ["emailUnverified"]);
    expect(code).toBe("accepted");
    expect(result?.idClaims.email_verified).toBe(false);
    const info = await h.rp.userinfo(result?.accessToken ?? "", String(result?.idClaims.sub));
    expect(info.email_verified).toBe(false);
  });

  fault("emailVerifiedAbsent", async () => {
    const h = harness();
    const { result } = await attempt(h, ["emailVerifiedAbsent"]);
    expect(result?.idClaims.email).toBe("riley.chen@example.com");
    expect("email_verified" in (result?.idClaims ?? {})).toBe(false);
    const info = await h.rp.userinfo(result?.accessToken ?? "", String(result?.idClaims.sub));
    expect("email_verified" in info).toBe(false);
  });

  fault("subjectChanged", async () => {
    const h = harness();
    const normal = await attempt(h, []);
    const changed = await attempt(h, ["subjectChanged"]);
    expect(changed.result?.idClaims.email).toBe(normal.result?.idClaims.email);
    expect(changed.result?.idClaims.sub).not.toBe(normal.result?.idClaims.sub);
    // Consistent within the flow: userinfo asserts the same (new) subject.
    const info = await h.rp.userinfo(
      changed.result?.accessToken ?? "",
      String(changed.result?.idClaims.sub),
    );
    expect(info.sub).toBe(changed.result?.idClaims.sub);
  });
});

describe("token response faults", () => {
  fault("idTokenAsAccessToken", async () => {
    const h = harness({ profile: "keycloak", clientId: "public-spa" });
    const { code, result } = await attempt(h, ["idTokenAsAccessToken"]);
    expect(code).toBe("accepted");
    expect(result?.accessToken).toBe(result?.idToken);
    expect(result?.idClaims.at_hash).toBeUndefined();
    const error = await h.rp
      .validateAccessToken(result?.accessToken ?? "", "test-api", "keycloak")
      .then(
        () => "accepted",
        (e: RpError) => e.code,
      );
    expect(error).toBe("not_an_access_token");
  });

  fault("jwksRotatedMidFlow", async () => {
    const h = harness();
    // Warm the relying party's JWKS cache.
    expect((await attempt(h, [])).code).toBe("accepted");
    const before = await publishedKids(h);
    const fetchesBefore = h.jwksFetches();
    const { code, result } = await attempt(h, ["jwksRotatedMidFlow"]);
    // A correct relying party refetches once on the unknown kid, and accepts.
    expect(code).toBe("accepted");
    expect(before).not.toContain(decode(result?.idToken ?? "").header.kid);
    expect(h.jwksFetches()).toBe(fetchesBefore + 1);
  });
});

describe("authorisation response faults", () => {
  const cases: Array<[FaultName, string]> = [
    ["codeForAnotherClient", "token_error:invalid_grant"],
    ["codeReplay", "token_error:invalid_grant"],
    ["pkceMismatch", "token_error:invalid_grant"],
    ["tamperedState", "state_mismatch"],
    ["wrongResponseIssuer", "response_iss_mismatch"],
  ];
  for (const [name, rule] of cases) {
    fault(name, async () => {
      expect((await attempt(harness(), [name])).code).toBe(rule);
    });
  }
});

describe("endpoint faults", () => {
  fault("discoveryIssuerMismatch", async () => {
    const h = harness();
    h.t.idp.faults.set({ discoveryIssuerMismatch: true });
    expect(h.t.idp.discovery().issuer).toBe(`${h.t.issuer}-mixup`);
    expect((await attempt(h, [])).code).toBe("discovery_issuer_mismatch");
  });

  fault("jwksSlow", async () => {
    const h = harness({ jwksTimeoutMs: 100 });
    h.t.idp.faults.set({ jwksSlow: { delayMs: 400 } });
    expect((await attempt(h, [])).code).toBe("jwks_timeout");
  });

  fault("jwksFailing", async () => {
    const h = harness();
    h.t.idp.faults.set({ jwksFailing: { status: 500 } });
    const response = await h.t.fetch(new Request(`${h.t.issuer}/jwks`));
    expect(response.status).toBe(500);
    expect((await attempt(h, [])).code).toBe("jwks_unavailable");
  });

  fault("userinfoSubjectMismatch", async () => {
    const h = harness();
    const { result } = await attempt(h, []);
    h.t.idp.faults.set({ userinfoSubjectMismatch: true });
    const error = await h.rp.userinfo(result?.accessToken ?? "", String(result?.idClaims.sub)).then(
      () => "accepted",
      (e: RpError) => e.code,
    );
    expect(error).toBe("userinfo_sub_mismatch");
  });
});

describe("the catalogue", () => {
  it("has a test for every fault", () => {
    expect([...covered].sort()).toEqual([...FAULT_NAMES].sort());
  });

  it("documents what the provider does and what the relying party must do for each", () => {
    for (const name of FAULT_NAMES) {
      expect(FAULT_CATALOGUE[name].provider.length).toBeGreaterThan(10);
      expect(FAULT_CATALOGUE[name].relyingParty.length).toBeGreaterThan(10);
    }
  });
});
