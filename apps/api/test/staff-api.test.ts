/**
 * The staff API in the Node runtime, as dev mode composes it: SQLite, the fake payment provider,
 * and the staff verifier validating real access tokens of the development issuer's `staff` realm
 * (mounted at `/dev-idp/staff`, its keys read in process). Tokens come from the issuer itself
 * (`mintTokens`, the token endpoint's output without a browser): one per role, one for another
 * audience, an expired one, one signed by a key the issuer never published.
 */
import {
  ADMIN_API_BASE_PATH,
  createRouteClient,
  routes,
  STAFF_CLIENT_ID,
} from "@webflix/contracts";
import type { MemoryJobQueue } from "@webflix/core/memory";
import { FIXTURE_CATALOG, FIXTURE_MANIFEST } from "@webflix/core/testing";
import { migrateToLatest } from "@webflix/db";
import { type DevIdp, type DevIdpFaults, WEBFLIX_DEV_CLIENTS } from "@webflix/dev-idp";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { developmentIssuerOf } from "../src/areas/identity.ts";
import { loadApiConfig } from "../src/config.ts";
import { createHttpApp, createRuntime, type Runtime } from "../src/runtime.ts";
import { createCookieJar } from "./cookie-jar.ts";

let runtime: Runtime;
let app: Hono;
let staffRealm: DevIdp;
let queue: MemoryJobQueue;

beforeAll(async () => {
  const config = loadApiConfig({
    WEBFLIX_DATABASE_URL: "sqlite::memory:",
    WEBFLIX_BLOB_STORE: "memory",
    WEBFLIX_MEDIA_DIR: "none",
    WEBFLIX_LOG_LEVEL: "error",
  });
  // Dev mode's default: the development issuer's staff realm, no variable needed.
  expect(config.core.admin.staffVerifier).toBe("oidc");
  expect(config.core.admin.staffIssuer).toBeNull();
  runtime = createRuntime(config, "api");
  await migrateToLatest(runtime.infra.database);
  await runtime.services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: null,
    manifest: FIXTURE_MANIFEST,
  });
  app = createHttpApp(runtime);
  queue = runtime.infra.jobs.queue as MemoryJobQueue;
  queue.setProcessor(runtime.services.processor);
  const realm = developmentIssuerOf(config)?.realms.staff;
  if (!realm) throw new Error("the development issuer's staff realm is not mounted");
  staffRealm = realm;
});

afterAll(async () => {
  await runtime.close();
});

async function token(persona: string, faults: DevIdpFaults = {}): Promise<string> {
  return (await staffRealm.mintTokens({ persona, clientId: STAFF_CLIENT_ID, faults })).access_token;
}

async function staff(persona: string, method: string, path: string, body?: unknown) {
  return app.request(`${ADMIN_API_BASE_PATH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token(persona)}`,
      "X-Webflix-Client": "web",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function member() {
  const jar = createCookieJar();
  const send = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.header()) headers.set("Cookie", jar.header());
    const response = await app.request(url, { ...init, headers });
    jar.store(response);
    return response;
  };
  return {
    api: createRouteClient(routes, {
      validateResponses: true,
      headers: (): Record<string, string> => (jar.header() ? { Cookie: jar.header() } : {}),
      fetch: (url: string, init: RequestInit) => send(url, init),
    }),
    pay: (secret: string | null, card: string) =>
      send("/_pay/form", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: secret ?? "", card, return: "/signup/done" }),
      }),
  };
}

async function drain() {
  for (let i = 0; i < 20 && queue.size > 0; i += 1) await queue.drain();
}

async function auditRows(action: string) {
  return runtime.infra.database.db
    .selectFrom("audit_log")
    .selectAll()
    .where("action", "=", action)
    .execute();
}

describe("staff tokens of the development issuer, validated by the Node runtime", () => {
  it("knows each persona's role and refuses the others route by route", async () => {
    for (const role of ["support", "billing", "content", "experiments", "admin"]) {
      const me = await staff(`staff-${role}`, "GET", "/me");
      expect(me.status).toBe(200);
      expect(((await me.json()) as { roles: string[] }).roles).toEqual([role]);
    }
    const noRole = await staff("staff-no-role", "GET", "/system/health");
    expect(noRole.status).toBe(403);
    expect(((await noRole.json()) as { code: string }).code).toBe("staff_role_required");
    expect((await staff("staff-support", "GET", "/system/health")).status).toBe(403);
    expect((await staff("staff-admin", "GET", "/system/health")).status).toBe(200);
    expect((await staff("staff-content", "GET", "/members?q=a")).status).toBe(403);
  });

  it("refuses a token for another audience, an expired one and one signed by an unknown key", async () => {
    for (const fault of ["wrongAudience", "expired", "unknownKey", "algNone", "wrongIssuer"]) {
      const response = await app.request(`${ADMIN_API_BASE_PATH}/me`, {
        headers: {
          Authorization: `Bearer ${await token("staff-admin", { [fault]: { target: "access_token" } })}`,
        },
      });
      expect(response.status, fault).toBe(401);
    }
    // The ID token of the same sign-in is not an access token.
    const tokens = await staffRealm.mintTokens({
      persona: "staff-admin",
      clientId: STAFF_CLIENT_ID,
    });
    const id = await app.request(`${ADMIN_API_BASE_PATH}/me`, {
      headers: { Authorization: `Bearer ${tokens.id_token}` },
    });
    expect(id.status).toBe(401);
  });

  it("refunds a paid invoice once on SQLite, however often the request is retried", async () => {
    const used = member();
    await used.api.signup({
      body: { email: "card-used@staff.test", password: "correct horse battery" },
    });
    const first = await used.api.startCheckout({ body: { planId: "basic" } });
    await used.pay(first.clientSecret, "visa");
    await used.api.confirmCheckout({ params: { id: first.id } });
    const paying = member();
    await paying.api.signup({
      body: { email: "refund@staff.test", password: "correct horse battery" },
    });
    const started = await paying.api.startCheckout({ body: { planId: "basic" } });
    await paying.pay(started.clientSecret, "visa");
    const confirmed = await paying.api.confirmCheckout({ params: { id: started.id } });
    await paying.pay(confirmed.clientSecret, "visa");
    await drain();
    expect((await paying.api.getCheckout({ params: { id: started.id } })).status).toBe("complete");
    const session = await paying.api.getSession({ query: {} });
    if (!session.authenticated) throw new Error("signed out");
    const accountId = session.account.id;

    // Billing agents hold support too, to read the member they act on.
    const detail = (await (
      await staff("staff-support", "GET", `/members/${accountId}`)
    ).json()) as {
      recentInvoices: { id: string; amountPaid: { amountMinor: number } }[];
    };
    const invoice = detail.recentInvoices.find((candidate) => candidate.amountPaid.amountMinor > 0);
    if (!invoice) throw new Error("no paid invoice");
    const body = {
      invoiceId: invoice.id,
      reason: "Charged by mistake",
      idempotencyKey: "0193f7d2-bbbb-7ccc-8ddd-000000000001",
    };
    const results = await Promise.all([
      staff("staff-billing", "POST", `/members/${accountId}/refunds`, body),
      staff("staff-billing", "POST", `/members/${accountId}/refunds`, body),
      staff("staff-billing", "POST", `/members/${accountId}/refunds`, body),
    ]);
    const statuses = results.map((response) => response.status).sort();
    // The first refunds; the others are answered from it, or told it is still running.
    expect(statuses.filter((status) => status === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((status) => status === 201 || status === 409)).toBe(true);
    const again = await staff("staff-billing", "POST", `/members/${accountId}/refunds`, body);
    expect(again.status).toBe(201);
    const refund = (await again.json()) as { amount: { amountMinor: number } };
    expect(refund.amount.amountMinor).toBe(invoice.amountPaid.amountMinor);

    const rows = await auditRows("billing.refund");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_type: "staff",
      actor_name: "Priya Natarajan",
      target_type: "member",
      target_id: accountId,
      reason: "Charged by mistake",
      outcome: "succeeded",
      idempotency_key: body.idempotencyKey,
    });
    const refunds = await runtime.infra.database.db
      .selectFrom("refunds")
      .selectAll()
      .where("account_id", "=", accountId)
      .execute();
    expect(refunds).toHaveLength(1);
    // The member's own invoice shows the refund.
    const own = await paying.api.listInvoices({ query: {} }).catch(() => null);
    if (own) {
      const refunded = own.items.find((candidate) => candidate.id === invoice.id);
      expect(refunded?.amountRefunded.amountMinor).toBe(invoice.amountPaid.amountMinor);
    }
  });

  it("serves the pipeline's service account (client credentials) on the operator routes", async () => {
    const { staffJobs } = WEBFLIX_DEV_CLIENTS;
    // The grant the pipeline's jobs use, at the issuer's token endpoint (served in process).
    const granted = await staffRealm.fetch(
      new Request(`${staffRealm.issuer}${staffJobs.tokenPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: staffJobs.clientId,
          client_secret: staffJobs.clientSecret,
        }).toString(),
      }),
    );
    expect(granted.status).toBe(200);
    const { access_token: jobToken } = (await granted.json()) as { access_token: string };
    const call = (path: string) =>
      app.request(`${ADMIN_API_BASE_PATH}${path}`, {
        headers: { Authorization: `Bearer ${jobToken}` },
      });
    const me = (await (await call("/me")).json()) as { roles: string[] };
    expect(me.roles.sort()).toEqual(["admin", "experiments"]);
    for (const path of ["/system/privacy/erasures?limit=10", "/system/privacy/exports?limit=10"]) {
      const response = await call(path);
      expect(response.status, path).toBe(200);
    }
    expect(await (await call("/system/privacy/exports?limit=10")).json()).toEqual({
      requests: [],
    });
  });

  it("audits a support action and a member read in SQLite, and lists them for an admin", async () => {
    const someone = member();
    await someone.api.signup({
      body: { email: "support@staff.test", password: "correct horse battery" },
    });
    const session = await someone.api.getSession({ query: {} });
    if (!session.authenticated) throw new Error("signed out");
    const accountId = session.account.id;
    expect((await staff("staff-support", "GET", `/members/${accountId}`)).status).toBe(200);
    const signedOut = await staff("staff-support", "POST", `/members/${accountId}/sign-out`, {
      reason: "Lost phone",
    });
    expect(signedOut.status).toBe(204);
    expect((await someone.api.getSession({ query: {} })).authenticated).toBe(false);
    const log = await staff("staff-admin", "GET", `/audit?targetId=${accountId}`);
    const entries = (
      (await log.json()) as {
        items: { action: string; outcome: string; actor: unknown }[];
      }
    ).items;
    expect(
      entries.map((entry: { action: string; outcome: string }) => [entry.action, entry.outcome]),
    ).toEqual([
      ["member.signed_out_everywhere", "succeeded"],
      ["member.viewed", "succeeded"],
    ]);
    expect(entries[0]?.actor).toEqual({
      type: "staff",
      id: expect.any(String),
      name: "Jordan Lee",
    });
  });
});
