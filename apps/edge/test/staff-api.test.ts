/**
 * The staff API in the Workers runtime (workerd): the OpenID staff verifier against the
 * `StaffVerifier` contract on Web Crypto, and the staff routes through the real Worker on D1,
 * with access tokens of the development issuer's `staff` realm this Worker serves (keys read in
 * process): each role, another audience, an expired token, an unknown key; a support action and
 * its audit entry in D1; a dead letter recorded by the job processor and replayed.
 */
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ADMIN_API_BASE_PATH,
  API_BASE_PATH,
  STAFF_API_AUDIENCE,
  STAFF_CLIENT_ID,
} from "@webflix/contracts";
import { createOidcStaffVerifier, JOB_MAX_ATTEMPTS } from "@webflix/core";
import {
  describeStaffVerifierContract,
  FIXTURE_CATALOG,
  FIXTURE_MANIFEST,
  type StaffTokenRequest,
} from "@webflix/core/testing";
import { createDevIdp, type DevIdpFaults, type DevIdpPersona } from "@webflix/dev-idp";
import { beforeAll, describe, expect, it } from "vitest";
import { developmentIssuerOf } from "../src/areas/identity.ts";
import { JOBS_MAX_ATTEMPTS } from "../src/env.ts";
import { handleFetch } from "../src/index.ts";
import { getRuntime } from "../src/runtime.ts";

const ISSUER = "https://staff-idp.test/realms/webflix";
const CLIENT = {
  clientId: STAFF_CLIENT_ID,
  redirectUris: ["https://console.test/admin/auth/callback"],
  accessTokenAudience: [STAFF_API_AUDIENCE, "account"],
};

function issuer(personas?: readonly DevIdpPersona[]) {
  return createDevIdp({
    issuer: ISSUER,
    environment: "test",
    profile: "keycloak",
    clients: [CLIENT],
    ...(personas ? { personas } : {}),
  });
}

async function mintFor(request: StaffTokenRequest, extra: DevIdpFaults = {}): Promise<string> {
  const access = { target: "access_token" } as const;
  const faults: DevIdpFaults = { ...extra };
  if ((request.expiresInSec ?? 300) < 0) faults.expired = access;
  if ((request.notBeforeSec ?? 0) > 0) faults.notYetValid = access;
  if (request.audience !== undefined) faults.wrongAudience = access;
  if (request.issuer !== undefined) faults.wrongIssuer = access;
  const tokens = await issuer([
    {
      id: "contract",
      sub: request.subject,
      email: request.email ?? null,
      name: request.name ?? null,
      roles: {
        ...(request.realmRoles ? { realm: request.realmRoles } : {}),
        clients: request.clientRoles ?? {},
      },
    },
  ]).mintTokens({ persona: "contract", clientId: STAFF_CLIENT_ID, faults });
  if (request.tokenType !== "id") return tokens.access_token;
  if (!tokens.id_token) throw new Error("no ID token");
  return tokens.id_token;
}

describeStaffVerifierContract("OpenID (workerd, Web Crypto)", () => {
  const idp = issuer();
  return {
    verifier: createOidcStaffVerifier({
      issuer: ISSUER,
      audience: STAFF_API_AUDIENCE,
      clientId: STAFF_CLIENT_ID,
      fetch: (request) => idp.fetch(request),
    }),
    mint: (request) => mintFor(request),
    forge: (request) => mintFor(request, { unknownKey: { target: "access_token" } }),
  };
});

interface Envelope {
  type: string;
  payload: unknown;
}

describe("the staff API through the Worker (D1)", () => {
  const queued: Envelope[] = [];
  const jobs = {
    async send(body: Envelope) {
      queued.push(body);
    },
    async sendBatch(messages: Array<{ body: Envelope }>) {
      for (const message of messages) queued.push(message.body);
    },
  } as unknown as Queue;
  const testEnv = { ...env, JOBS: jobs } as typeof env;

  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await getRuntime(testEnv).services.seeder.seed({
      catalog: FIXTURE_CATALOG,
      demoAccount: null,
      manifest: FIXTURE_MANIFEST,
    });
  });

  const origin = () => getRuntime(testEnv).config.core.publicOrigin;
  const send = (path: string, init: RequestInit = {}) =>
    handleFetch(new Request(`${origin()}${path}`, init), testEnv, createExecutionContext());

  async function token(persona: string, faults: DevIdpFaults = {}): Promise<string> {
    getRuntime(testEnv);
    const realm = developmentIssuerOf(testEnv)?.realms.staff;
    if (!realm) throw new Error("the development issuer's staff realm is not served");
    return (await realm.mintTokens({ persona, clientId: STAFF_CLIENT_ID, faults })).access_token;
  }

  async function staff(persona: string, method: string, path: string, body?: unknown) {
    return send(`${ADMIN_API_BASE_PATH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await token(persona)}`,
        "X-Webflix-Client": "web",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("validates the issuer's access tokens: each role, and refuses the faulty ones", async () => {
    expect(getRuntime(testEnv).config.core.admin.staffVerifier).toBe("oidc");
    for (const role of ["support", "billing", "content", "experiments", "admin"]) {
      const response = await staff(`staff-${role}`, "GET", "/me");
      expect(response.status, role).toBe(200);
      expect(((await response.json()) as { roles: string[] }).roles).toEqual([role]);
    }
    const refused = await staff("staff-content", "GET", "/system/health");
    expect(refused.status).toBe(403);
    for (const fault of ["wrongAudience", "expired", "unknownKey", "hmacKeyConfusion"]) {
      const response = await send(`${ADMIN_API_BASE_PATH}/me`, {
        headers: {
          Authorization: `Bearer ${await token("staff-admin", { [fault]: { target: "access_token" } })}`,
        },
      });
      expect(response.status, fault).toBe(401);
    }
  });

  it("signs a member out with its audit entry in D1, and the member's session never opens the staff API", async () => {
    const signup = await send(`${API_BASE_PATH}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webflix-Client": "web" },
      body: JSON.stringify({ email: "edge-staff@example.test", password: "correct horse battery" }),
    });
    expect(signup.status).toBe(201);
    const cookie = (signup.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const session = (await signup.json()) as { account: { id: string } };
    const accountId = session.account.id;
    const asMember = await send(`${ADMIN_API_BASE_PATH}/members/${accountId}`, {
      headers: { Cookie: cookie },
    });
    expect(asMember.status).toBe(401);
    const asStaffOnMember = await send(`${API_BASE_PATH}/account`, {
      headers: { Authorization: `Bearer ${await token("staff-admin")}` },
    });
    expect(asStaffOnMember.status).toBe(401);

    const out = await staff("staff-support", "POST", `/members/${accountId}/sign-out`, {
      reason: "Takeover reported",
    });
    expect(out.status).toBe(204);
    const after = await send(`${API_BASE_PATH}/session`, { headers: { Cookie: cookie } });
    expect(((await after.json()) as { authenticated: boolean }).authenticated).toBe(false);
    const row = await env.DB.prepare(
      "select action, actor_name, target_id, reason, outcome, completed_at from audit_log where target_id = ? and action = ?",
    )
      .bind(accountId, "member.signed_out_everywhere")
      .first();
    expect(row).toMatchObject({
      action: "member.signed_out_everywhere",
      actor_name: "Jordan Lee",
      target_id: accountId,
      reason: "Takeover reported",
      outcome: "succeeded",
    });
    expect(row?.completed_at).not.toBeNull();
  });

  it("records a job that fails its last attempt, lists it without its payload, and replays it once", async () => {
    // The processor records on the attempt Queues dead-letters at (max_retries + 1).
    expect(JOBS_MAX_ATTEMPTS).toBe(JOB_MAX_ATTEMPTS);
    const runtime = getRuntime(testEnv);
    const id = crypto.randomUUID();
    const outcome = await runtime.services.processor({
      id,
      type: "no.such-job",
      payload: { email: "private@example.test" },
      attempt: JOBS_MAX_ATTEMPTS,
      enqueuedAt: Date.now(),
    });
    expect(outcome.action).toBe("retry");
    const listed = await staff("staff-admin", "GET", "/system/dead-letters");
    const text = await listed.text();
    expect(text).not.toContain("private@example.test");
    expect(JSON.parse(text).items).toEqual([
      expect.objectContaining({ id, jobType: "no.such-job", attempts: JOBS_MAX_ATTEMPTS }),
    ]);
    queued.length = 0;
    const replayed = await staff("staff-admin", "POST", `/system/dead-letters/${id}/replay`, {
      reason: "Fixed",
    });
    expect(replayed.status).toBe(200);
    expect(queued).toEqual([
      { v: 1, type: "no.such-job", payload: { email: "private@example.test" } },
    ]);
    const twice = await staff("staff-admin", "POST", `/system/dead-letters/${id}/replay`, {
      reason: "Again",
    });
    expect(twice.status).toBe(409);
    const health = (await (await staff("staff-admin", "GET", "/system/health")).json()) as {
      dependencies: { name: string; up: boolean }[];
      jobs: { depth: number | null; deadLetters: number };
    };
    expect(health.dependencies.every((dependency) => dependency.up)).toBe(true);
    expect(health.jobs.depth).toBeNull();
  });
});
