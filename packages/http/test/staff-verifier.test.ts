/**
 * The staff verifier against a real issuer (Node): `createOidcStaffVerifier` passes the
 * `StaffVerifier` contract against the development issuer's Keycloak profile, and refuses every
 * token fault of its catalogue that applies to an access token, by the rule the catalogue states
 * (packages/dev-idp/README.md). The same file's cases run in workerd in apps/edge.
 */
import { STAFF_API_AUDIENCE, STAFF_CLIENT_ID } from "@webflix/contracts";
import {
  createOidcStaffVerifier,
  type OidcStaffVerifierOptions,
  StaffTokenError,
  type StaffTokenFailureReason,
} from "@webflix/core";
import { describeStaffVerifierContract, type StaffTokenRequest } from "@webflix/core/testing";
import {
  createDevIdp,
  createWebflixDevIdp,
  type DevIdp,
  type DevIdpFaults,
  type DevIdpPersona,
} from "@webflix/dev-idp";
import { describe, expect, it } from "vitest";

const base64UrlDecode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const base64UrlEncode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const utf8Decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8Encode = (value: string) => new TextEncoder().encode(value);

const ISSUER = "https://staff-idp.test/realms/webflix";
const CLIENT = {
  clientId: STAFF_CLIENT_ID,
  redirectUris: ["https://console.test/admin/auth/callback"],
  accessTokenAudience: [STAFF_API_AUDIENCE, "account"],
};

/** A Keycloak-like staff issuer with these personas (the profile's development keys). */
function issuer(personas?: readonly DevIdpPersona[]): DevIdp {
  return createDevIdp({
    issuer: ISSUER,
    environment: "test",
    profile: "keycloak",
    clients: [CLIENT],
    ...(personas ? { personas } : {}),
  });
}

function verifierFor(idp: Pick<DevIdp, "fetch">, options: Partial<OidcStaffVerifierOptions> = {}) {
  return createOidcStaffVerifier({
    issuer: ISSUER,
    audience: STAFF_API_AUDIENCE,
    clientId: STAFF_CLIENT_ID,
    fetch: (request) => idp.fetch(request),
    ...options,
  });
}

/** The contract's request as a persona and the faults that produce it. */
async function mintFor(request: StaffTokenRequest, extra: DevIdpFaults = {}): Promise<string> {
  const persona: DevIdpPersona = {
    id: "contract",
    sub: request.subject,
    email: request.email ?? null,
    name: request.name ?? null,
    roles: {
      ...(request.realmRoles ? { realm: request.realmRoles } : {}),
      clients: request.clientRoles ?? {},
    },
  };
  const access = { target: "access_token" } as const;
  const faults: DevIdpFaults = { ...extra };
  if ((request.expiresInSec ?? 300) < 0) faults.expired = access;
  if ((request.notBeforeSec ?? 0) > 0) faults.notYetValid = access;
  if (request.audience !== undefined) faults.wrongAudience = access;
  if (request.issuer !== undefined) faults.wrongIssuer = access;
  // Every instance of the profile signs with the same development keys: the verifier fetches
  // them from its own instance.
  const tokens = await issuer([persona]).mintTokens({
    persona: "contract",
    clientId: STAFF_CLIENT_ID,
    faults,
  });
  if (request.tokenType !== "id") return tokens.access_token;
  if (!tokens.id_token) throw new Error("no ID token");
  return tokens.id_token;
}

describeStaffVerifierContract("OpenID (development issuer, Keycloak profile)", () => {
  const idp = issuer();
  return {
    verifier: verifierFor(idp),
    mint: (request) => mintFor(request),
    forge: (request) => mintFor(request, { unknownKey: { target: "access_token" } }),
  };
});

async function refusal(promise: Promise<unknown>): Promise<StaffTokenFailureReason> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "expected the token to be refused").toBeInstanceOf(StaffTokenError);
  return (error as StaffTokenError).reason;
}

describe("the staff verifier against the development issuer's staff realm", () => {
  const ORIGIN = "http://localhost:5730";
  function realm() {
    const host = createWebflixDevIdp({ environment: "test", origin: ORIGIN });
    const staff = host.realms.staff;
    if (!staff) throw new Error("no staff realm");
    return { host, staff };
  }
  const verifierOf = (host: { fetch(request: Request): Promise<Response> }, more = {}) =>
    createOidcStaffVerifier({
      issuer: `${ORIGIN}/dev-idp/staff`,
      audience: STAFF_API_AUDIENCE,
      clientId: STAFF_CLIENT_ID,
      fetch: (request) => host.fetch(request),
      allowHttp: true,
      ...more,
    });
  const mint = async (staff: DevIdp, persona: string, faults: DevIdpFaults = {}) =>
    (await staff.mintTokens({ persona, clientId: STAFF_CLIENT_ID, faults })).access_token;
  const access = { target: "access_token" } as const;

  it("maps each persona's role, and none for staff without a Webflix role", async () => {
    const { host, staff } = realm();
    const verifier = verifierOf(host);
    for (const role of ["support", "billing", "content", "experiments", "admin"]) {
      const identity = await verifier.verify(await mint(staff, `staff-${role}`));
      expect(identity.roles).toEqual([role]);
      expect(identity.email).toMatch(/@staff\.webflix\.dev$/);
    }
    expect((await verifier.verify(await mint(staff, "staff-no-role"))).roles).toEqual([]);
    expect((await verifier.verify(await mint(staff, "staff-other-client-admin"))).roles).toEqual(
      [],
    );
  });

  it("refuses each token fault of the catalogue that applies to an access token", async () => {
    const { host, staff } = realm();
    const verifier = verifierOf(host);
    const cases: [keyof DevIdpFaults, StaffTokenFailureReason][] = [
      ["unknownKey", "signature"],
      ["removedKey", "signature"],
      ["algNone", "signature"],
      ["hmacKeyConfusion", "signature"],
      ["embeddedJwk", "signature"],
      ["wrongIssuer", "issuer"],
      ["wrongAudience", "audience"],
      ["expired", "expired"],
      ["notYetValid", "not_yet_valid"],
    ];
    for (const [fault, reason] of cases) {
      const token = await mint(staff, "staff-admin", { [fault]: access });
      expect(await refusal(verifier.verify(token)), fault).toBe(reason);
    }
  });

  it("refuses an ID token presented as the access token", async () => {
    const { host, staff } = realm();
    const tokens = await staff.mintTokens({
      persona: "staff-admin",
      clientId: STAFF_CLIENT_ID,
      faults: { idTokenAsAccessToken: true },
    });
    expect(tokens.access_token).toBe(tokens.id_token);
    expect(await refusal(verifierOf(host).verify(tokens.access_token))).toBe("token_type");
  });

  it("accepts another audience next to its own (RFC 9068), unlike an ID token", async () => {
    const { host, staff } = realm();
    const token = await mint(staff, "staff-billing", { extraAudience: access });
    expect((await verifierOf(host).verify(token)).roles).toEqual(["billing"]);
  });

  it("follows a key rotation: an unknown kid refetches the keys once", async () => {
    const { host, staff } = realm();
    const verifier = verifierOf(host, { jwksRefetchCooldownSec: 0 });
    await verifier.verify(await mint(staff, "staff-admin")); // keys cached
    const rotated = await mint(staff, "staff-admin", { jwksRotatedMidFlow: true });
    expect((await verifier.verify(rotated)).roles).toEqual(["admin"]);
  });

  it("refuses an issuer whose discovery names another issuer", async () => {
    const { host, staff } = realm();
    staff.faults.set({ discoveryIssuerMismatch: true });
    const token = await mint(staff, "staff-admin");
    expect(await refusal(verifierOf(host).verify(token))).toBe("unavailable");
  });

  it("answers unavailable, never a verified identity, when the keys cannot be fetched", async () => {
    const { host, staff } = realm();
    const token = await mint(staff, "staff-admin");
    staff.faults.set({ jwksFailing: { status: 503 } });
    expect(await refusal(verifierOf(host).verify(token))).toBe("unavailable");
    staff.faults.set({ jwksSlow: { delayMs: 2000 } });
    expect(await refusal(verifierOf(host, { timeoutMs: 100 }).verify(token))).toBe("unavailable");
  });

  it("keeps the keys it already trusts through an issuer outage", async () => {
    const { host, staff } = realm();
    const verifier = verifierOf(host, { cacheTtlSec: 0 });
    const token = await mint(staff, "staff-support");
    await verifier.verify(token);
    staff.faults.set({ jwksFailing: { status: 500 } });
    expect((await verifier.verify(token)).roles).toEqual(["support"]);
    // A token signed by a key it never saw is still refused.
    staff.faults.clear();
    const unknown = await mint(staff, "staff-support", { unknownKey: access });
    staff.faults.set({ jwksFailing: { status: 500 } });
    expect(["signature", "unavailable"]).toContain(await refusal(verifier.verify(unknown)));
  });

  it("fixes the algorithm by configuration: an ES256-only verifier refuses RS256 tokens", async () => {
    const { host, staff } = realm();
    const token = await mint(staff, "staff-admin");
    expect(await refusal(verifierOf(host, { algorithms: ["ES256"] }).verify(token))).toBe(
      "signature",
    );
  });

  it("refuses a header with critical extensions, and refuses http issuers unless allowed", async () => {
    const { host, staff } = realm();
    const token = await mint(staff, "staff-admin");
    const [header = "", body = "", signature = ""] = token.split(".");
    const decoded = JSON.parse(utf8Decode(base64UrlDecode(header)));
    const withCrit = base64UrlEncode(utf8Encode(JSON.stringify({ ...decoded, crit: ["exp"] })));
    expect(["malformed", "signature"]).toContain(
      await refusal(verifierOf(host).verify(`${withCrit}.${body}.${signature}`)),
    );
    expect(() =>
      createOidcStaffVerifier({
        issuer: `${ORIGIN}/dev-idp/staff`,
        audience: STAFF_API_AUDIENCE,
        clientId: STAFF_CLIENT_ID,
      }),
    ).toThrow(/https/);
    expect(() =>
      createOidcStaffVerifier({
        issuer: "https://idp.test/realms/webflix/",
        audience: STAFF_API_AUDIENCE,
        clientId: STAFF_CLIENT_ID,
      }),
    ).toThrow(/canonical/);
  });
});
