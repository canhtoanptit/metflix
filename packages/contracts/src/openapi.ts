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
import { ERROR_CATALOG, type ErrorCode } from "./error-codes.ts";
import { Problem } from "./errors.ts";
import {
  API_BASE_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
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
}

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
};

const SESSION_SCHEME = "sessionCookie";
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

function errorResponses(route: RouteSpec): Record<string, JsonSchema> {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of routeErrorCodes(route)) {
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

/** Build the OpenAPI 3.1 document for a route table (the full API by default). */
export function buildOpenApiDocument(
  table: RouteTable = defaultRoutes,
  options: OpenApiOptions = {},
): OpenApiDocument {
  const registry = new ComponentRegistry();
  registry.add(Problem, "output");

  const prepared = Object.entries(table).map(([operationId, route]) => ({
    operationId,
    route,
    params: route.params ? registry.add(route.params, "input") : null,
    query: route.query ? registry.add(route.query, "input") : null,
    body: route.body ? registry.add(route.body, "input") : null,
    response: route.response ? registry.add(route.response, "output") : null,
  }));
  const { schemas, rewrite } = registry.finalize();

  const paths: OpenApiDocument["paths"] = {};
  for (const { operationId, route, params, query, body, response } of prepared) {
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
    if (!isSafeMethod(route.method)) {
      parameters.push({
        name: CLIENT_HEADER,
        in: "header",
        required: true,
        description: "CSRF defence: must be present on every non-GET request.",
        schema: { type: "string", const: CLIENT_HEADER_VALUE },
      });
    }

    const status = successStatus(route);
    const operation: JsonSchema = {
      operationId,
      tags: [route.tag],
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(body
        ? {
            requestBody: {
              required: !isBodyOptional(route),
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: rewrite(body.root, "input"),
                  ...(route.examples?.request === undefined
                    ? {}
                    : { example: route.examples.request }),
                },
              },
            },
          }
        : {}),
      responses: {
        [String(status)]: response
          ? {
              description: "Success",
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: rewrite(response.root, "output"),
                  ...(route.examples?.response === undefined
                    ? {}
                    : { example: route.examples.response }),
                },
              },
            }
          : { description: "No content" },
        ...errorResponses(route),
      },
      security: route.auth === "public" ? [] : [{ [SESSION_SCHEME]: [] }],
      "x-webflix-auth": route.auth,
      ...(route.rateLimit ? { "x-webflix-rate-limit": route.rateLimit } : {}),
      ...(route.rateLimit && route.rateLimitScope === "handler"
        ? { "x-webflix-rate-limit-scope": "handler" }
        : {}),
    };

    const path = `${API_BASE_PATH}${toOpenApiPath(route.path)}`;
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
      },
    },
  };
}
