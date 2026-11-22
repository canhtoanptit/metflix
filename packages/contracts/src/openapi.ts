/**
 * OpenAPI 3.1 document generated from the route table with zod's native JSON Schema
 * conversion (draft 2020-12, the dialect of OpenAPI 3.1). No schema is restated: named
 * schemas (`.meta({ id })`) become `components.schemas`, everything else is inlined.
 *
 * Request schemas are converted with zod's `input` view and responses with its `output`
 * view. When a named schema differs between the two (defaults, coercions, transforms) the
 * input variant is published as `<Id>Input`.
 */
import * as z from "zod";
import { adminRoutes } from "./admin-routes.ts";
import { ERROR_CATALOG, type ErrorCode } from "./error-codes.ts";
import { Problem } from "./errors.ts";
import {
  ADMIN_API_BASE_PATH,
  API_BASE_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  FORM_CONTENT_TYPE,
  isSafeMethod,
  JSON_CONTENT_TYPE,
  PROBLEM_CONTENT_TYPE,
} from "./http.ts";
import {
  isBodyOptional,
  ROUTE_TAGS,
  type RouteSpec,
  type RouteTable,
  type RouteTag,
  routeErrorCodes,
  successStatus,
  toOpenApiPath,
} from "./route.ts";
import { routes as defaultRoutes } from "./routes.ts";

export type JsonSchema = { [key: string]: unknown };

export interface OpenApiDocument {
  openapi: "3.1.1";
  info: { title: string; version: string; description?: string };
  servers?: { url: string; description?: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, JsonSchema>>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes: Record<string, JsonSchema>;
  };
}

export interface OpenApiOptions {
  title?: string;
  version?: string;
  description?: string;
  servers?: { url: string; description?: string }[];
  /** Name of the session cookie, for the security scheme. */
  sessionCookieName?: string;
  /**
   * Operation ids the serving deployment registers but has not implemented yet: marked
   * `x-webflix-implementation: pending` with their `501 not_implemented` response.
   */
  pending?: ReadonlySet<string>;
}

/** A route table and the prefix it is served under. */
export interface RouteMount {
  table: RouteTable;
  basePath: string;
}

/** Everything the API serves: the member API and the staff API. */
export const API_MOUNTS: readonly RouteMount[] = [
  { table: defaultRoutes, basePath: API_BASE_PATH },
  { table: adminRoutes, basePath: ADMIN_API_BASE_PATH },
];

const TAG_DESCRIPTIONS: Record<RouteTag, string> = {
  auth: "Sign up, sign in and the session bootstrap.",
  account: "Membership, plans, payment and devices.",
  profiles: "Profiles and avatars.",
  browse: "Personalised browse views, rows and genre pages.",
  titles: "Title detail, episodes and similar titles.",
  search: "Search as you type.",
  library: "My List, ratings, Continue Watching and viewing activity.",
  notifications: "In-app notifications.",
  playback: "Playback sessions and progress heartbeats.",
  billing: "Checkout, plan changes, payment methods, invoices and promo codes.",
  events: "Behaviour events from the telemetry SDK.",
  privacy: "Consent, data export and account deletion.",
  webhooks: "Signed callbacks from payment and email providers.",
  diagnostics: "Test surfaces of local modes (never in production).",
  admin: "The staff API (bearer tokens from the staff issuer).",
};

const SESSION_SCHEME = "sessionCookie";
const STAFF_SCHEME = "staffBearer";
const DEFS_PREFIX = "#/$defs/";
const COMPONENTS_PREFIX = "#/components/schemas/";

type Io = "input" | "output";

interface Conversion {
  io: Io;
  root: JsonSchema;
  defs: Record<string, JsonSchema>;
}

function convert(schema: z.ZodType, io: Io): Conversion {
  const json = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
    unrepresentable: "throw",
    cycles: "ref",
    reused: "inline",
  }) as JsonSchema;
  const { $schema: _dialect, $defs, ...root } = json;
  return { io, root, defs: ($defs ?? {}) as Record<string, JsonSchema> };
}

function mapRefs(value: unknown, rename: (id: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapRefs(item, rename));
  if (value === null || typeof value !== "object") return value;
  const out: JsonSchema = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] =
      key === "$ref" && typeof child === "string" && child.startsWith(DEFS_PREFIX)
        ? `${COMPONENTS_PREFIX}${rename(child.slice(DEFS_PREFIX.length))}`
        : mapRefs(child, rename);
  }
  return out;
}

function referencedIds(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) referencedIds(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith(DEFS_PREFIX)) {
        into.add(child.slice(DEFS_PREFIX.length));
      } else {
        referencedIds(child, into);
      }
    }
  }
  return into;
}

/**
 * Collects named definitions from every conversion, decides which input variants can share
 * the output component, and rewrites `$defs` references into `components.schemas`.
 */
class ComponentRegistry {
  private readonly conversions: Conversion[] = [];
  private readonly outputDefs = new Map<string, JsonSchema>();
  private readonly inputDefs = new Map<string, JsonSchema>();

  add(schema: z.ZodType, io: Io): Conversion {
    const conversion = convert(schema, io);
    const target = io === "output" ? this.outputDefs : this.inputDefs;
    for (const [id, def] of Object.entries(conversion.defs)) {
      const existing = target.get(id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(def)) {
        throw new Error(`Two different schemas are registered with id "${id}"`);
      }
      target.set(id, def);
    }
    this.conversions.push(conversion);
    return conversion;
  }

  /** Must be called after every `add`. Returns the components and a ref rewriter per io. */
  finalize(): {
    schemas: Record<string, JsonSchema>;
    rewrite: (value: unknown, io: Io) => JsonSchema;
  } {
    // An input def shares the output component when identical and all its refs share too.
    const shared = new Set<string>();
    for (const [id, def] of this.inputDefs) {
      const output = this.outputDefs.get(id);
      if (output && JSON.stringify(output) === JSON.stringify(def)) shared.add(id);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of shared) {
        const refs = referencedIds(this.inputDefs.get(id));
        if ([...refs].some((ref) => this.inputDefs.has(ref) && !shared.has(ref))) {
          shared.delete(id);
          changed = true;
        }
      }
    }
    const nameFor = (id: string, io: Io) =>
      io === "output" || shared.has(id) || !this.outputDefs.has(id) ? id : `${id}Input`;
    const rewrite = (value: unknown, io: Io) =>
      mapRefs(value, (id) => nameFor(id, io)) as JsonSchema;

    const schemas: Record<string, JsonSchema> = {};
    for (const [id, def] of this.outputDefs) schemas[id] = rewrite(def, "output");
    for (const [id, def] of this.inputDefs) {
      const name = nameFor(id, "input");
      if (!(name in schemas)) schemas[name] = rewrite(def, "input");
    }
    return { schemas: sortKeys(schemas), rewrite };
  }
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function objectProperties(root: JsonSchema): {
  properties: Record<string, JsonSchema>;
  required: Set<string>;
} {
  return {
    properties: (root.properties ?? {}) as Record<string, JsonSchema>,
    required: new Set((root.required ?? []) as string[]),
  };
}

function errorResponses(route: RouteSpec, pending: boolean): Record<string, JsonSchema> {
  const byStatus = new Map<number, ErrorCode[]>();
  const codes = routeErrorCodes(route);
  if (pending) codes.push("not_implemented");
  for (const code of codes) {
    const status = ERROR_CATALOG[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const responses: Record<string, JsonSchema> = {};
  for (const [status, codes] of [...byStatus].sort(([a], [b]) => a - b)) {
    responses[String(status)] = {
      description: `Problem: ${codes.map((code) => `\`${code}\``).join(", ")}`,
      content: { [PROBLEM_CONTENT_TYPE]: { schema: { $ref: `${COMPONENTS_PREFIX}Problem` } } },
    };
  }
  return responses;
}

function requestBodyOf(
  route: RouteSpec,
  body: Conversion | null,
  rewrite: (value: unknown, io: Io) => JsonSchema,
): JsonSchema | null {
  if (route.bodyEncoding === "raw") {
    return {
      required: true,
      description:
        "Verified over the exact bytes received (the provider's signature header) before it is parsed.",
      content: { [JSON_CONTENT_TYPE]: { schema: {} } },
    };
  }
  if (!body) return null;
  const contentType = route.bodyEncoding === "form" ? FORM_CONTENT_TYPE : JSON_CONTENT_TYPE;
  return {
    required: !isBodyOptional(route),
    content: {
      [contentType]: {
        schema: rewrite(body.root, "input"),
        ...(route.examples?.request === undefined ? {} : { example: route.examples.request }),
      },
    },
  };
}

function successResponse(
  route: RouteSpec,
  response: Conversion | null,
  rewrite: (value: unknown, io: Io) => JsonSchema,
): JsonSchema {
  if (route.redirect !== undefined) {
    return {
      description: "Redirect (a browser navigation)",
      headers: { Location: { required: true, schema: { type: "string" } } },
    };
  }
  if (!response) return { description: "No content" };
  return {
    description: "Success",
    content: {
      [JSON_CONTENT_TYPE]: {
        schema: rewrite(response.root, "output"),
        ...(route.examples?.response === undefined ? {} : { example: route.examples.response }),
      },
    },
  };
}

function securityOf(route: RouteSpec): JsonSchema[] {
  if (route.auth === "public") return [];
  return [{ [route.auth === "staff" ? STAFF_SCHEME : SESSION_SCHEME]: [] }];
}

/**
 * Build the OpenAPI 3.1 document: by default everything the API serves (`API_MOUNTS`); a single
 * table is documented under `API_BASE_PATH`.
 */
export function buildOpenApiDocument(
  tables: RouteTable | readonly RouteMount[] = API_MOUNTS,
  options: OpenApiOptions = {},
): OpenApiDocument {
  const mounts: readonly RouteMount[] = Array.isArray(tables)
    ? (tables as readonly RouteMount[])
    : [{ table: tables as RouteTable, basePath: API_BASE_PATH }];
  const registry = new ComponentRegistry();
  registry.add(Problem, "output");

  const seen = new Set<string>();
  const prepared = mounts.flatMap(({ table, basePath }) =>
    Object.entries(table).map(([operationId, route]) => {
      if (seen.has(operationId)) throw new Error(`Duplicate operation id "${operationId}"`);
      seen.add(operationId);
      return {
        operationId,
        route,
        basePath,
        params: route.params ? registry.add(route.params, "input") : null,
        query: route.query ? registry.add(route.query, "input") : null,
        body: route.body ? registry.add(route.body, "input") : null,
        response: route.response ? registry.add(route.response, "output") : null,
      };
    }),
  );
  const { schemas, rewrite } = registry.finalize();

  const paths: OpenApiDocument["paths"] = {};
  for (const { operationId, route, basePath, params, query, body, response } of prepared) {
    const parameters: JsonSchema[] = [];
    for (const [location, conversion] of [
      ["path", params],
      ["query", query],
    ] as const) {
      if (!conversion) continue;
      const { properties, required } = objectProperties(conversion.root);
      for (const [name, schema] of Object.entries(properties)) {
        const { description, ...rest } = schema;
        parameters.push({
          name,
          in: location,
          required: location === "path" || required.has(name),
          ...(typeof description === "string" ? { description } : {}),
          schema: rewrite(rest, "input"),
        });
      }
    }
    if (!isSafeMethod(route.method) && route.csrf !== "none") {
      parameters.push({
        name: CLIENT_HEADER,
        in: "header",
        required: true,
        description: "CSRF defence: must be present on every non-GET request.",
        schema: { type: "string", const: CLIENT_HEADER_VALUE },
      });
    }

    const status = successStatus(route);
    const pending = options.pending?.has(operationId) === true;
    const requestBody = requestBodyOf(route, body, rewrite);
    const operation: JsonSchema = {
      operationId,
      tags: [route.tag],
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: {
        [String(status)]: successResponse(route, response, rewrite),
        ...errorResponses(route, pending),
      },
      security: securityOf(route),
      "x-webflix-auth": route.auth,
      "x-webflix-area": route.area,
      ...(route.staffRole ? { "x-webflix-staff-role": route.staffRole } : {}),
      ...(route.rateLimit ? { "x-webflix-rate-limit": route.rateLimit } : {}),
      ...(route.rateLimit && route.rateLimitScope === "handler"
        ? { "x-webflix-rate-limit-scope": "handler" }
        : {}),
      ...(route.csrf === "none" ? { "x-webflix-csrf": "none" } : {}),
      ...(pending ? { "x-webflix-implementation": "pending" } : {}),
    };

    const path = `${basePath}${toOpenApiPath(route.path)}`;
    paths[path] = { ...paths[path], [route.method.toLowerCase()]: operation };
  }

  return {
    openapi: "3.1.1",
    info: {
      title: options.title ?? "Webflix API",
      version: options.version ?? "1.0.0",
      ...(options.description ? { description: options.description } : {}),
    },
    ...(options.servers ? { servers: options.servers } : {}),
    tags: ROUTE_TAGS.map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
    paths,
    components: {
      schemas,
      securitySchemes: {
        [SESSION_SCHEME]: {
          type: "apiKey",
          in: "cookie",
          name: options.sessionCookieName ?? "webflix_session",
          description: "Opaque httpOnly session cookie set by sign-up and sign-in.",
        },
        [STAFF_SCHEME]: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "A staff access token from the staff issuer (audience `webflix-admin-api`, roles of the `webflix-admin` client).",
        },
      },
    },
  };
}
