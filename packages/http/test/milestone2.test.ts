/**
 * The foundation of milestone 2 in the HTTP layer: registered-but-unimplemented routes answer one
 * uniform problem, the staff API's guard, and the new route kinds (form posts, raw signed
 * bodies, redirects, per-route body limits, the CSRF exemption).
 */
import {
  ADMIN_API_BASE_PATH,
  API_BASE_PATH,
  adminRoutes,
  createAdminApiClient,
  defineRoute,
  isClientRoute,
  type RouteSpec,
  routes,
} from "@webflix/contracts";
import { MemoryStaffVerifier } from "@webflix/core/memory";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bindRoutes,
  createAdminHandlers,
  createHandlers,
  pendingOperations,
  problemErrorHandler,
  problemNotFoundHandler,
  requireClientHeader,
} from "../src/index.ts";
import { createTestApp } from "./support.ts";

const params: Record<string, string> = {
  id: "x1",
  provider: "google",
  accountId: "acct-1",
  profileId: "prof-1",
  planId: "basic",
  currency: "USD",
  view: "home",
  titleId: "t-1",
  key: "recs.test",
};

function pathOf(base: string, route: RouteSpec): string {
  return `${base}${route.path.replaceAll(/:([A-Za-z]+)/g, (_, name: string) => params[name] ?? "x")}`;
}

describe("routes registered but not implemented", () => {
  it("answer 501 not_implemented, the same way to every caller, naming operation and area", async () => {
    const t = await createTestApp();
    const handlers = createHandlers(t.container);
    const adminHandlers = createAdminHandlers(t.container);
    const pending = [
      ...pendingOperations(handlers).map(
        (name) => [name, routes[name as keyof typeof routes], API_BASE_PATH] as const,
      ),
      ...pendingOperations(adminHandlers).map(
        (name) =>
          [name, adminRoutes[name as keyof typeof adminRoutes], ADMIN_API_BASE_PATH] as const,
      ),
    ];
    // Every area has implemented its routes now (the admin area's wave closed the last ones), so
    // the mechanism is also checked on a route bound with `notImplemented()` behind the real
    // guard; the uniform answer is checked for any real route still pending too.
    const { createGuard } = await import("../src/session.ts");
    const { notImplemented } = await import("../src/index.ts");
    const probe = new Hono();
    probe.onError(problemErrorHandler());
    bindRoutes(
      probe as never,
      {
        probeRoute: defineRoute({
          method: "POST",
          path: "/probe/:id",
          tag: "admin",
          area: "admin",
          auth: "staff",
          staffRole: "admin",
          summary: "probe",
          params: z.object({ id: z.string() }),
          body: z.object({ reason: z.string() }),
          response: null,
        }),
      },
      { probeRoute: notImplemented() },
      { guard: createGuard(t.container) as never, basePath: ADMIN_API_BASE_PATH },
    );
    const synthetic = await probe.request(`${ADMIN_API_BASE_PATH}/probe/x1`, { method: "POST" });
    expect(synthetic.status).toBe(501);
    expect(await synthetic.json()).toMatchObject({
      code: "not_implemented",
      operationId: "probeRoute",
      area: "admin",
    });
    for (const [name, route, base] of pending) {
      // Anonymous, no CSRF header, no body: still the uniform answer.
      const response = await t.request(pathOf(base, route), { method: route.method });
      expect(response.status, name).toBe(501);
      expect(response.headers.get("Content-Type")).toBe("application/problem+json");
      expect(await response.json(), name).toMatchObject({
        code: "not_implemented",
        operationId: name,
        area: route.area,
      });
    }
  });

  it("are exactly the operations the served OpenAPI document marks pending", async () => {
    const t = await createTestApp();
    const document = (await (await t.request("/api/openapi.json")).json()) as {
      paths: Record<
        string,
        Record<string, { operationId: string; "x-webflix-implementation"?: string }>
      >;
    };
    const marked = Object.values(document.paths)
      .flatMap((methods) => Object.values(methods))
      .filter((operation) => operation["x-webflix-implementation"] === "pending")
      .map((operation) => operation.operationId)
      .sort();
    const expected = [
      ...pendingOperations(createHandlers(t.container)),
      ...pendingOperations(createAdminHandlers(t.container)),
    ].sort();
    expect(marked).toEqual(expected);
    // Milestone 1 is fully implemented.
    for (const name of ["getSession", "signup", "getBrowse", "createPlaybackSession"]) {
      expect(expected).not.toContain(name);
    }
  });
});

describe("the staff API", () => {
  async function staffApp() {
    const verifier = new MemoryStaffVerifier();
    const t = await createTestApp();
    // The staff port of this app's services (memory), so tokens it mints verify.
    const token = (roles: string[]) =>
      (t.ports.staff as MemoryStaffVerifier).mint({
        subject: "staff-1",
        name: "Ada",
        clientRoles: { "webflix-admin": roles },
      });
    return { t, token, verifier };
  }

  it("refuses a request without a valid bearer token, and ignores the member session", async () => {
    const { t, verifier } = await staffApp();
    const none = await t.request(`${ADMIN_API_BASE_PATH}/me`);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ code: "unauthenticated" });
    const forged = await t.request(`${ADMIN_API_BASE_PATH}/me`, {
      headers: {
        Authorization: `Bearer ${await verifier.mint({ subject: "x", clientRoles: {} })}`,
      },
    });
    expect(forged.status).toBe(401);
    expect(forged.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers the staff member's identity through the typed admin client", async () => {
    const { t, token } = await staffApp();
    const accessToken = await token(["support", "billing"]);
    const api = createAdminApiClient({
      accessToken: () => accessToken,
      fetch: async (url, init) => t.app.request(url, init),
    });
    expect(await api.getStaffSelf()).toEqual({
      subject: "staff-1",
      name: "Ada",
      email: null,
      roles: ["support", "billing"],
    });
  });

  it("enforces each route's role (admin passes every check)", async () => {
    const { t, token } = await staffApp();
    const table = {
      refund: defineRoute({
        method: "GET",
        path: "/probe-billing",
        tag: "admin",
        area: "admin",
        auth: "staff",
        staffRole: "billing",
        summary: "probe",
        response: z.object({ ok: z.literal(true) }),
      }),
    };
    const app = new Hono();
    app.onError(problemErrorHandler());
    const { createGuard } = await import("../src/session.ts");
    bindRoutes(
      app as never,
      table,
      { refund: () => ({ ok: true as const }) },
      {
        guard: createGuard(t.container) as never,
        basePath: ADMIN_API_BASE_PATH,
      },
    );
    const call = async (roles: string[]) =>
      app.request(`${ADMIN_API_BASE_PATH}/probe-billing`, {
        headers: { Authorization: `Bearer ${await token(roles)}` },
      });
    const support = await call(["support"]);
    expect(support.status).toBe(403);
    expect(await support.json()).toMatchObject({
      code: "staff_role_required",
      requiredRole: "billing",
    });
    expect((await call(["billing"])).status).toBe(200);
    expect((await call(["admin"])).status).toBe(200);
  });
});

describe("milestone 2 route kinds", () => {
  const table = {
    formCallback: defineRoute({
      method: "POST",
      path: "/callback/:provider",
      tag: "auth",
      area: "identity",
      auth: "public",
      summary: "form post",
      params: z.object({ provider: z.enum(["apple"]) }),
      body: z.object({ code: z.string(), state: z.string() }),
      bodyEncoding: "form",
      csrf: "none",
      response: null,
      redirect: 303,
    }),
    webhook: defineRoute({
      method: "POST",
      path: "/hook",
      tag: "webhooks",
      area: "billing",
      auth: "public",
      summary: "raw",
      bodyEncoding: "raw",
      maxBodyBytes: 64,
      csrf: "none",
      response: z.object({ bytes: z.number() }),
    }),
    small: defineRoute({
      method: "POST",
      path: "/small",
      tag: "events",
      area: "events",
      auth: "public",
      summary: "small json",
      body: z.object({ text: z.string() }),
      maxBodyBytes: 32,
      response: null,
    }),
  };
  const received: { form?: unknown; raw?: Uint8Array } = {};

  function app() {
    const hono = new Hono();
    hono.onError(problemErrorHandler());
    hono.notFound(problemNotFoundHandler());
    bindRoutes(
      hono,
      table,
      {
        formCallback: ({ params: p, body }) => {
          received.form = { provider: p.provider, ...body };
          return { location: `/browse?oidc=signed-in&state=${body.state}` };
        },
        webhook: ({ body }) => {
          received.raw = body;
          return { bytes: body.byteLength };
        },
        small: () => undefined,
      },
      { guard: requireClientHeader },
    );
    return hono;
  }

  it("parses a form post without the client header and redirects", async () => {
    const response = await app().request(`${API_BASE_PATH}/callback/apple`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=c1&state=s1",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/browse?oidc=signed-in&state=s1");
    expect(received.form).toEqual({ provider: "apple", code: "c1", state: "s1" });
  });

  it("refuses a form post with a repeated field or as JSON", async () => {
    const repeated = await app().request(`${API_BASE_PATH}/callback/apple`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=c1&state=s1&state=s2",
    });
    expect(await repeated.json()).toMatchObject({ code: "validation_failed" });
    const json = await app().request(`${API_BASE_PATH}/callback/apple`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "c1", state: "s1" }),
    });
    expect(await json.json()).toMatchObject({ code: "unsupported_media_type" });
  });

  it("hands a raw body to the handler byte for byte, within its own limit", async () => {
    const bytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xe2, 0x82, 0xac, 0x7d]);
    const response = await app().request(`${API_BASE_PATH}/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bytes,
    });
    expect(await response.json()).toEqual({ bytes: bytes.byteLength });
    expect(received.raw).toEqual(bytes);
    const tooLarge = await app().request(`${API_BASE_PATH}/hook`, {
      method: "POST",
      body: new Uint8Array(65),
    });
    expect(await tooLarge.json()).toMatchObject({ code: "payload_too_large" });
  });

  it("applies a route's own body limit and still requires the client header elsewhere", async () => {
    const send = (text: string, header = true) =>
      app().request(`${API_BASE_PATH}/small`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(header ? { "X-Webflix-Client": "web" } : {}),
        },
        body: JSON.stringify({ text }),
      });
    expect((await send("ok")).status).toBe(204);
    expect(await (await send("x".repeat(40))).json()).toMatchObject({ code: "payload_too_large" });
    expect(await (await send("ok", false)).json()).toMatchObject({ code: "csrf_check_failed" });
  });

  it("keeps redirect, form and raw routes out of the typed client", () => {
    expect(isClientRoute(table.formCallback)).toBe(false);
    expect(isClientRoute(table.webhook)).toBe(false);
    expect(isClientRoute(table.small)).toBe(true);
  });
});
