/**
 * The client-credentials grant (RFC 6749 §4.4) for service accounts, as Keycloak answers it: the
 * batch jobs' way to a staff token (`webflix-jobs` in the Webflix staff realm).
 */
import { describe, expect, it } from "vitest";
import { createWebflixDevIdp, WEBFLIX_DEV_CLIENTS } from "../src/index.ts";

type Json = Record<string, unknown>;
const ORIGIN = "http://localhost:5173";
const host = () => createWebflixDevIdp({ environment: "test", origin: ORIGIN });
const STAFF = `${ORIGIN}/dev-idp/staff`;

function decode(token: string): { header: Json; claims: Json } {
  const [h = "", c = ""] = token.split(".");
  const json = (part: string) =>
    JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as Json;
  return { header: json(h), claims: json(c) };
}

async function verifies(token: string, jwks: { keys: Json[] }): Promise<boolean> {
  const [h = "", c = "", s = ""] = token.split(".");
  const jwk = jwks.keys.find((key) => key.kid === decode(token).header.kid) as
    | Record<string, string>
    | undefined;
  if (!jwk) return false;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty ?? "", n: jwk.n ?? "", e: jwk.e ?? "" },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
    ch.charCodeAt(0),
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${h}.${c}`),
  );
}

function tokenRequest(form: Record<string, string>, basic?: [string, string]) {
  return new Request(`${STAFF}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(basic ? { Authorization: `Basic ${btoa(`${basic[0]}:${basic[1]}`)}` } : {}),
    },
    body: new URLSearchParams(form),
  });
}

describe("client credentials (service accounts)", () => {
  const { clientId, clientSecret, roles } = WEBFLIX_DEV_CLIENTS.staffJobs;

  it("issues the jobs' service account a Keycloak-shaped staff access token, and nothing else", async () => {
    const idp = host();
    for (const request of [
      tokenRequest({ grant_type: "client_credentials" }, [clientId, clientSecret]),
      tokenRequest({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    ]) {
      const response = await idp.fetch(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = (await response.json()) as Json;
      expect(Object.keys(body).sort()).toEqual([
        "access_token",
        "expires_in",
        "scope",
        "token_type",
      ]);
      expect(body.token_type).toBe("Bearer");
      expect(body.scope).toBe("email profile roles"); // the realm's scopes, as Keycloak's defaults
      const { header, claims } = decode(String(body.access_token));
      expect(header).toMatchObject({ typ: "JWT", alg: "RS256" });
      expect(claims).toMatchObject({
        iss: STAFF,
        aud: ["webflix-admin-api", "account"],
        typ: "Bearer",
        azp: clientId,
        preferred_username: `service-account-${clientId}`,
        resource_access: { "webflix-admin": { roles: [...roles] } },
      });
      expect(String(claims.sub)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(Number(claims.exp) - Number(claims.iat)).toBe(Number(body.expires_in));
      const jwks = (await (await idp.fetch(new Request(`${STAFF}/jwks`))).json()) as {
        keys: Json[];
      };
      expect(await verifies(String(body.access_token), jwks)).toBe(true);
    }
  });

  it("refuses a wrong secret, a client without a service account, openid, and the consumer realms", async () => {
    const idp = host();
    const wrong = await idp.fetch(
      tokenRequest({ grant_type: "client_credentials" }, [clientId, "not-the-secret-value"]),
    );
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as Json).error).toBe("invalid_client");
    const console = await idp.fetch(
      tokenRequest({
        grant_type: "client_credentials",
        client_id: WEBFLIX_DEV_CLIENTS.staff.clientId,
      }),
    );
    expect(((await console.json()) as Json).error).toBe("unauthorized_client");
    const openid = await idp.fetch(
      tokenRequest({ grant_type: "client_credentials", scope: "openid" }, [clientId, clientSecret]),
    );
    expect(((await openid.json()) as Json).error).toBe("invalid_scope");
    const offline = await idp.fetch(
      tokenRequest({ grant_type: "client_credentials", scope: "offline_access" }, [
        clientId,
        clientSecret,
      ]),
    );
    expect(((await offline.json()) as Json).error).toBe("invalid_scope");
    const narrowed = await idp.fetch(
      tokenRequest({ grant_type: "client_credentials", scope: "email" }, [clientId, clientSecret]),
    );
    expect(((await narrowed.json()) as Json).scope).toBe("email");
    const google = await idp.fetch(
      new Request(`${ORIGIN}/dev-idp/google/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: WEBFLIX_DEV_CLIENTS.google.clientId,
          client_secret: WEBFLIX_DEV_CLIENTS.google.clientSecret,
        }),
      }),
    );
    expect(((await google.json()) as Json).error).toBe("unsupported_grant_type");
  });

  it("advertises the grant where it exists, and the service client cannot start a sign-in", async () => {
    const idp = host();
    const staff = (await (
      await idp.fetch(new Request(`${STAFF}/.well-known/openid-configuration`))
    ).json()) as Json;
    expect(staff.grant_types_supported).toContain("client_credentials");
    const google = (await (
      await idp.fetch(new Request(`${ORIGIN}/dev-idp/google/.well-known/openid-configuration`))
    ).json()) as Json;
    expect(google.grant_types_supported).not.toContain("client_credentials");
    const authorize = await idp.fetch(
      new Request(
        `${STAFF}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(`${ORIGIN}/x`)}&scope=openid&state=s&nonce=n`,
      ),
    );
    expect(authorize.status).toBe(400);
    expect(authorize.headers.get("Location")).toBeNull();
  });
});
