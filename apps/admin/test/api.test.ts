/** The staff API client and how failures of a change are sorted. */
import { ApiError, ERROR_CATALOG, type ErrorCode } from "@webflix/contracts";
import { describe, expect, it, vi } from "vitest";
import { createStaffApi } from "../src/api/client.ts";
import { classifyFailure, describeError, isRetryable } from "../src/api/errors.ts";

function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ type: `urn:webflix:problem:${code}`, title: code, status, code, ...extra }),
    { status, headers: { "Content-Type": "application/problem+json" } },
  );
}

describe("createStaffApi", () => {
  it("sends the bearer token, no cookie, and renews once after a 401", async () => {
    let token = "first";
    const session = {
      accessToken: vi.fn(async () => token),
      renewAfterRefusal: vi.fn(async () => {
        token = "second";
        return true;
      }),
      expire: vi.fn(),
    };
    const calls: { authorization: string | null; credentials: string | undefined }[] = [];
    const fetch = vi.fn(async (_input: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      calls.push({ authorization: headers.get("Authorization"), credentials: init.credentials });
      return calls.length === 1
        ? problem(401, "unauthenticated")
        : new Response(
            JSON.stringify({ subject: "s", name: null, email: null, roles: ["admin"] }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
    });
    const api = createStaffApi(session, fetch);
    const me = await api.getStaffSelf();
    expect(me.roles).toEqual(["admin"]);
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer first", "Bearer second"]);
    expect(calls.every((call) => call.credentials === "omit")).toBe(true);
    expect(session.expire).not.toHaveBeenCalled();
  });

  it("ends the session when the renewed token is refused too", async () => {
    const session = {
      accessToken: vi.fn(async () => "token"),
      renewAfterRefusal: vi.fn(async () => true),
      expire: vi.fn(),
    };
    const api = createStaffApi(session, async () => problem(401, "unauthenticated"));
    await expect(api.getStaffSelf()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(session.expire).toHaveBeenCalledOnce();
  });

  it("sends mutations with the client header", async () => {
    let headers = new Headers();
    const api = createStaffApi(
      {
        accessToken: async () => "t",
        renewAfterRefusal: async () => false,
        expire: () => undefined,
      },
      async (_input, init) => {
        headers = new Headers(init.headers);
        return new Response(null, { status: 204 });
      },
    );
    await api.signOutMemberEverywhere({
      params: { accountId: "a1" },
      body: { reason: "lost phone" },
    });
    expect(headers.get("X-Webflix-Client")).toBe("web");
  });
});

describe("classifyFailure", () => {
  const api = (code: ErrorCode, extra: Record<string, unknown> = {}) =>
    new ApiError({
      type: `urn:webflix:problem:${code}`,
      title: ERROR_CATALOG[code].title,
      status: ERROR_CATALOG[code].status,
      code,
      ...extra,
    } as unknown as ConstructorParameters<typeof ApiError>[0]);

  it("treats a lost answer as no answer (may or may not have happened)", () => {
    expect(
      classifyFailure(new ApiError({ type: "x", title: "x", status: 0, code: "network_error" }))
        .kind,
    ).toBe("no-answer");
    expect(classifyFailure(new DOMException("deadline", "TimeoutError")).kind).toBe("no-answer");
  });

  it("treats a 5xx as an unknown outcome and never repeats the server's 'try again'", () => {
    const failure = classifyFailure(
      api("service_unavailable", {
        detail: "The payment provider is not answering. Try again in a moment.",
      }),
    );
    expect(failure.kind).toBe("unknown");
    expect(failure.description).not.toMatch(/try again/i);
  });

  it("takes the earlier attempt's audit entry from a staff_action_conflict's auditId", () => {
    const failure = classifyFailure(
      api("staff_action_conflict", {
        detail: "The first attempt with this key is still running (audit entry 01a2-abc).",
        auditId: "01a2-abc",
      }),
    );
    expect(failure).toMatchObject({ kind: "conflict", auditEntryId: "01a2-abc" });
    expect(failure.title).toBe("An earlier attempt is on record");
    expect(classifyFailure(api("staff_action_conflict")).auditEntryId).toBeNull();
  });

  it("treats a 4xx as refused, unless the action makes more than one change", () => {
    expect(classifyFailure(api("checkout_state_conflict")).kind).toBe("refused");
    expect(classifyFailure(api("checkout_state_conflict"), { multiStep: true }).kind).toBe(
      "unknown",
    );
    expect(classifyFailure(api("unauthenticated")).kind).toBe("session");
    expect(classifyFailure(api("staff_role_required", { requiredRole: "billing" })).kind).toBe(
      "forbidden",
    );
  });

  it("retries reads only when retrying can help", () => {
    expect(isRetryable(api("service_unavailable"))).toBe(true);
    expect(isRetryable(api("not_found"))).toBe(false);
    expect(
      describeError(api("staff_role_required", { requiredRole: "billing" })).description,
    ).toContain("billing");
  });
});
