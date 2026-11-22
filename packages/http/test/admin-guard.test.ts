/**
 * Who may call the staff API, proven route by route for all of `adminRoutes` (a route added to
 * the table is covered without touching this file): a token without the route's role is refused
 * and changes nothing, `admin` passes every check, no token or a member session gets
 * `unauthenticated`, and a staff token never opens a member route.
 */
import {
  ADMIN_API_BASE_PATH,
  API_BASE_PATH,
  adminRoutes,
  type RouteSpec,
  routes,
  STAFF_ROLES,
} from "@webflix/contracts";
import type { MemoryAdminRepository, MemoryStaffVerifier } from "@webflix/core/memory";
import { describe, expect, it } from "vitest";
import { createTestApp, onboard, type TestApp } from "./support.ts";

const PARAMS: Record<string, string> = {
  accountId: "acct-guard",
  profileId: "prof-guard",
  id: "x1",
  planId: "basic",
  currency: "USD",
  view: "home",
  titleId: "t-orbit",
  key: "recs.guard",
  provider: "google",
  seasonNumber: "1",
  rowId: "home:trending",
  slug: "drama",
};

function pathOf(base: string, route: RouteSpec): string {
  return `${base}${route.path.replaceAll(/:([A-Za-z]+)/g, (_, name: string) => PARAMS[name] ?? "x")}`;
}

const adminEntries = Object.entries(adminRoutes) as [string, RouteSpec][];

async function staffToken(t: TestApp, roles: readonly string[]): Promise<string> {
  return (t.ports.staff as MemoryStaffVerifier).mint({
    subject: `staff-${roles.join("-") || "none"}`,
    name: "Guard Test",
    clientRoles: { "webflix-admin": [...roles] },
    // Noise the mapping must ignore: realm roles and another client's roles.
    realmRoles: ["admin"],
  });
}

async function call(
  t: TestApp,
  route: RouteSpec,
  headers: Record<string, string>,
  base = ADMIN_API_BASE_PATH,
): Promise<Response> {
  const hasBody =
    route.method !== "GET" && route.method !== "DELETE" ? true : route.body !== undefined;
  return t.request(pathOf(base, route), {
    method: route.method,
    headers: {
      // The client header, so a refusal is about who calls, not about CSRF.
      "X-Webflix-Client": "web",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(hasBody ? { body: JSON.stringify({ reason: "guard test" }) } : {}),
  });
}

describe("the staff API's guard, route by route", () => {
  it("refuses every route to every role that is not the route's (or admin), and refused calls change nothing", async () => {
    const t = await createTestApp();
    const audit = t.deps.repos.admin as MemoryAdminRepository;
    let refusals = 0;
    for (const [name, route] of adminEntries) {
      const required = route.staffRole;
      expect(required, name).toBeDefined();
      for (const role of [...STAFF_ROLES, null]) {
        const roles = role === null ? [] : [role];
        const allowed = required === "any" || role === "admin" || role === required;
        if (allowed) continue;
        const response = await call(t, route, {
          Authorization: `Bearer ${await staffToken(t, roles)}`,
        });
        expect(response.status, `${name} as ${role ?? "no role"}`).toBe(403);
        const problem = await response.json();
        expect(problem, `${name} as ${role ?? "no role"}`).toMatchObject({
          code: "staff_role_required",
          requiredRole: required,
        });
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        refusals += 1;
      }
    }
    // 38 routes: `GET /me` admits every role; every other route refuses 4 or 5 role sets.
    expect(refusals).toBeGreaterThan(adminEntries.length * 4);
    // Nothing was audited, queued or written for a refused call.
    expect(audit.audit).toEqual([]);
    expect(t.queue.size).toBe(0);
  });

  it("lets the route's role and admin through the guard on every route", async () => {
    const t = await createTestApp();
    for (const [name, route] of adminEntries) {
      const required = route.staffRole === "any" ? "support" : (route.staffRole ?? "admin");
      for (const roles of [[required], ["admin"]]) {
        const response = await call(t, route, {
          Authorization: `Bearer ${await staffToken(t, roles)}`,
        });
        // Past the guard: anything but an authentication or role refusal (the body is a
        // placeholder, so validation or a missing record may answer).
        expect(response.status, `${name} as ${roles[0]}`).not.toBe(401);
        if (response.status === 403) {
          expect((await response.json()).code, `${name} as ${roles[0]}`).not.toBe(
            "staff_role_required",
          );
        }
        expect(response.status, `${name} as ${roles[0]}`).not.toBe(501);
      }
    }
  });

  it("answers unauthenticated on every route without a valid staff token: none, garbage, a member's session", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "member@guard.test" });
    const cookie = [...device.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const sessionToken = [...device.cookies.values()][0] ?? "";
    for (const [name, route] of adminEntries) {
      const variants: Record<string, string>[] = [
        {},
        { Authorization: "Bearer not-a-token" },
        { Authorization: `Basic ${btoa("staff:password")}` },
        // A member's session never opens a staff route: not as a cookie, not as a bearer.
        { Cookie: cookie },
        { Authorization: `Bearer ${sessionToken}` },
      ];
      for (const headers of variants) {
        const response = await call(t, route, headers);
        expect(response.status, `${name} ${JSON.stringify(Object.keys(headers))}`).toBe(401);
        expect((await response.json()).code).toBe("unauthenticated");
      }
    }
  });

  it("never opens a member route with a staff token (even an admin's)", async () => {
    const t = await createTestApp();
    const admin = await staffToken(t, ["admin"]);
    const memberRoutes = (Object.entries(routes) as [string, RouteSpec][]).filter(
      ([, route]) => route.auth !== "public",
    );
    expect(memberRoutes.length).toBeGreaterThan(40);
    for (const [name, route] of memberRoutes) {
      const response = await call(t, route, { Authorization: `Bearer ${admin}` }, API_BASE_PATH);
      expect(response.status, name).toBe(401);
      expect((await response.json()).code, name).toBe("unauthenticated");
      expect(response.headers.getSetCookie(), name).toEqual([]);
    }
  });

  it("refuses expired, not-yet-valid, wrong-audience, wrong-issuer and ID tokens, and forged ones", async () => {
    const t = await createTestApp();
    const verifier = t.ports.staff as MemoryStaffVerifier;
    const route = adminRoutes.getSystemHealth;
    const roles = { "webflix-admin": ["admin"] };
    const tokens = [
      await verifier.mint({ subject: "s", clientRoles: roles, expiresInSec: -600 }),
      await verifier.mint({ subject: "s", clientRoles: roles, notBeforeSec: 900 }),
      await verifier.mint({ subject: "s", clientRoles: roles, audience: ["account"] }),
      await verifier.mint({ subject: "s", clientRoles: roles, issuer: "https://evil.test" }),
      await verifier.mint({ subject: "s", clientRoles: roles, tokenType: "id" }),
    ];
    const { MemoryStaffVerifier: Impostor } = await import("@webflix/core/memory");
    tokens.push(await new Impostor().mint({ subject: "s", clientRoles: roles }));
    for (const token of tokens) {
      const response = await call(t, route, { Authorization: `Bearer ${token}` });
      expect(response.status).toBe(401);
      // The reason stays in the logs; the caller learns nothing about it.
      expect((await response.json()).detail).toBe("Sign in to the staff console again");
    }
    const valid = await verifier.mint({ subject: "s", clientRoles: roles });
    expect((await call(t, route, { Authorization: `Bearer ${valid}` })).status).toBe(200);
  });

  it("refuses a mutation without the client header (CSRF), before the role is even looked at", async () => {
    const t = await createTestApp();
    const token = await staffToken(t, ["admin"]);
    const response = await t.request(`${ADMIN_API_BASE_PATH}/members/acct-guard/sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "guard test" }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("csrf_check_failed");
  });
});
