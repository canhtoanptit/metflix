import { compileErrors, validate } from "@readme/openapi-parser";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ADMIN_API_BASE_PATH,
  API_BASE_PATH,
  adminRoutes,
  defineRoute,
  routes,
  toOpenApiPath,
} from "../src/index.ts";
import { buildOpenApiDocument } from "../src/openapi.ts";

describe("buildOpenApiDocument", () => {
  const document = buildOpenApiDocument(routes, { version: "test" });
  const full = buildOpenApiDocument(undefined, {
    version: "test",
    pending: new Set(["getMember"]),
  });

  it("documents the member and staff APIs together by default, as valid OpenAPI 3.1", async () => {
    const result = await validate(structuredClone(full) as never);
    if (!result.valid) throw new Error(compileErrors(result));
    for (const [table, base] of [
      [routes, API_BASE_PATH],
      [adminRoutes, ADMIN_API_BASE_PATH],
    ] as const) {
      for (const [operationId, route] of Object.entries(table)) {
        const operation = full.paths[`${base}${toOpenApiPath(route.path)}`]?.[
          route.method.toLowerCase()
        ] as { operationId?: string; "x-webflix-area"?: string } | undefined;
        expect(operation?.operationId, `${route.method} ${route.path}`).toBe(operationId);
        expect(operation?.["x-webflix-area"]).toBe(route.area);
      }
    }
  });

  it("secures staff routes with the bearer scheme and names their role", () => {
    const member = full.paths[`${ADMIN_API_BASE_PATH}/members/{accountId}`]?.get as Record<
      string,
      unknown
    >;
    expect(member.security).toEqual([{ staffBearer: [] }]);
    expect(member["x-webflix-staff-role"]).toBe("support");
    expect(Object.keys(member.responses as object)).toEqual(
      expect.arrayContaining(["200", "401", "403", "404", "501"]),
    );
    expect(member["x-webflix-implementation"]).toBe("pending");
    expect(full.components.securitySchemes).toHaveProperty("staffBearer");
  });

  it("documents redirects, form posts and raw signed bodies", () => {
    const start = full.paths[`${API_BASE_PATH}/auth/oidc/{provider}/start`]?.get as {
      responses: Record<string, { headers?: Record<string, unknown> }>;
    };
    expect(start.responses["302"]?.headers).toHaveProperty("Location");
    const formCallback = full.paths[`${API_BASE_PATH}/auth/oidc/{provider}/callback`]?.post as {
      requestBody: { content: Record<string, unknown> };
      parameters: unknown[];
      "x-webflix-csrf"?: string;
    };
    expect(Object.keys(formCallback.requestBody.content)).toEqual([
      "application/x-www-form-urlencoded",
    ]);
    expect(JSON.stringify(formCallback.parameters)).not.toContain("X-Webflix-Client");
    expect(formCallback["x-webflix-csrf"]).toBe("none");
    const webhook = full.paths[`${API_BASE_PATH}/webhooks/payments/{provider}`]?.post as {
      requestBody: { description?: string };
    };
    expect(webhook.requestBody.description).toMatch(/exact bytes/);
  });

  it("produces a valid OpenAPI 3.1 document", async () => {
    // The validator mutates (dereferences) its input; give it a copy.
    const result = await validate(structuredClone(document) as never);
    if (!result.valid) throw new Error(compileErrors(result));
    expect(result.valid).toBe(true);
  });

  it("has one operation per route, keyed by operation id", () => {
    for (const [operationId, route] of Object.entries(routes)) {
      const operation = document.paths[`${API_BASE_PATH}${toOpenApiPath(route.path)}`]?.[
        route.method.toLowerCase()
      ] as { operationId?: string } | undefined;
      expect(operation?.operationId, `${route.method} ${route.path}`).toBe(operationId);
    }
  });

  it("publishes named schemas as components and leaves no $defs references", () => {
    for (const name of [
      "TitleCard",
      "TitleDetail",
      "Row",
      "PlaybackSession",
      "Problem",
      "ImageSet",
    ]) {
      expect(document.components.schemas).toHaveProperty(name);
    }
    expect(JSON.stringify(document)).not.toContain("#/$defs/");
  });

  it("documents auth, CSRF and problem responses", () => {
    const create = document.paths["/api/v1/playback/sessions"]?.post as Record<string, unknown>;
    expect(create.security).toEqual([{ sessionCookie: [] }]);
    expect(JSON.stringify(create.parameters)).toContain("X-Webflix-Client");
    expect(Object.keys(create.responses as object)).toEqual(
      expect.arrayContaining(["201", "400", "401", "402", "403", "404", "409", "500"]),
    );
    const session = document.paths["/api/v1/session"]?.get as Record<string, unknown>;
    expect(session.security).toEqual([]);
  });

  it("marks optional request bodies and handler-scoped rate limits", () => {
    const release = document.paths["/api/v1/playback/sessions/{id}"]?.delete as {
      requestBody?: { required: boolean; content: Record<string, { schema: unknown }> };
    };
    expect(release.requestBody?.required).toBe(false);
    expect(JSON.stringify(release.requestBody?.content)).toContain("HeartbeatBody");
    const heartbeat = document.paths["/api/v1/playback/sessions/{id}/heartbeat"]?.post as {
      requestBody?: { required: boolean };
    };
    expect(heartbeat.requestBody?.required).toBe(true);
    const select = document.paths["/api/v1/session/profile"]?.put as Record<string, unknown>;
    expect(select["x-webflix-rate-limit"]).toBe("profile-pin");
    expect(select["x-webflix-rate-limit-scope"]).toBe("handler");
    const payment = document.paths["/api/v1/account/payment-method"]?.put as Record<
      string,
      unknown
    >;
    expect(payment["x-webflix-rate-limit"]).toBe("payment");
    expect(payment).not.toHaveProperty("x-webflix-rate-limit-scope");
  });

  it("publishes route examples on the request and success bodies", () => {
    const payment = document.paths["/api/v1/account/payment-method"]?.put as {
      requestBody: { content: Record<string, { example?: unknown }> };
      responses: Record<string, { content: Record<string, { example?: unknown }> }>;
    };
    expect(payment.requestBody.content["application/json"]?.example).toEqual({
      payment: routes.updatePaymentMethod.examples.request.payment,
    });
    expect(payment.responses["200"]?.content["application/json"]?.example).toBeDefined();
  });

  it("splits a named schema into <Id>Input when request and response views differ", () => {
    const Thing = z.object({ size: z.number().default(1) }).meta({ id: "SplitThing" });
    const table = {
      putThing: defineRoute({
        method: "PUT",
        path: "/things",
        tag: "titles",
        area: "streaming",
        auth: "public",
        summary: "put",
        body: Thing,
        response: Thing,
      }),
    };
    const doc = buildOpenApiDocument(table);
    const output = doc.components.schemas.SplitThing as { required?: string[] };
    const input = doc.components.schemas.SplitThingInput as { required?: string[] };
    expect(output.required).toEqual(["size"]);
    expect(input.required ?? []).toEqual([]);
  });
});
