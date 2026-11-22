/**
 * `createDevIdp`: one OpenID Provider as a fetch handler (`Request` in, `Response` out), the
 * same on Node and in a Cloudflare Worker.
 */
import {
  DevIdpConfigError,
  type DevIdpOptions,
  type DevIdpPersona,
  normalizeConfig,
} from "./config.ts";
import { createContext, endpoint, type IssuerContext, log, nowSec } from "./context.ts";
import { randomToken } from "./encoding.ts";
import { handleAuthorize, handleSelect } from "./endpoints/authorize.ts";
import { handleLogout } from "./endpoints/logout.ts";
import { handleToken } from "./endpoints/token.ts";
import { handleUserinfo } from "./endpoints/userinfo.ts";
import { type DevIdpFaults, normalizeFaults } from "./faults.ts";
import {
  delay,
  json,
  methodNotAllowed,
  notFound,
  oauthError,
  preflight,
  withCors,
} from "./http.ts";
import type { Jwk, SigningAlgorithm } from "./jose.ts";
import type { KeyStatus } from "./keys.ts";
import type { PersonaRef } from "./personas.ts";
import type { ProfileName } from "./profiles.ts";
import {
  type Grant,
  identityFaultsOf,
  mintTokenResponse,
  refreshAllowed,
  sealRefreshToken,
  type TokenResponse,
} from "./tokens.ts";

export interface FaultController {
  /** Replaces the standing faults: every flow and endpoint gets them until `clear()`. */
  set(faults: DevIdpFaults): void;
  clear(): void;
  readonly active: DevIdpFaults;
}

export interface KeyController {
  /** Rotates each algorithm (or the one given): `next` starts signing. Returns the new signing kids. */
  rotate(alg?: SigningAlgorithm): Promise<string[]>;
  /** Removes a key from the JWKS (the current key hands over to `next`). */
  retire(kid: string): void;
  /** The published JWKS. */
  jwks(): { keys: Jwk[] };
  list(): Array<{ kid: string; alg: SigningAlgorithm; status: KeyStatus }>;
}

export interface MintTokensInput {
  /** A configured persona id, or a typed-email identity. */
  persona: string | { email: string; name?: string; verified: boolean };
  clientId: string;
  /** Default: every scope the client may request, minus offline_access. */
  scope?: string;
  nonce?: string;
  /** Seconds since the epoch. Default: now. */
  authTime?: number;
  faults?: DevIdpFaults;
}

export interface DevIdp {
  readonly issuer: string;
  readonly profile: ProfileName;
  /** Handles every request under the issuer's path; anything else is a 404. */
  fetch(request: Request): Promise<Response>;
  readonly faults: FaultController;
  readonly keys: KeyController;
  readonly personas: readonly DevIdpPersona[];
  readonly clientIds: readonly string[];
  /** The discovery document as served (faults included). */
  discovery(): Record<string, unknown>;
  /**
   * Tokens for a persona without a browser flow, as the token endpoint would return them: for
   * resource-server tests (for example the admin API validating staff access tokens).
   */
  mintTokens(input: MintTokensInput): Promise<TokenResponse>;
}

function discoveryDocument(context: IssuerContext): Record<string, unknown> {
  const profile = context.profile;
  const doc: Record<string, unknown> = {
    issuer: context.standingFaults.discoveryIssuerMismatch
      ? `${context.issuer}-mixup`
      : context.issuer,
    authorization_endpoint: endpoint(context, "/authorize"),
    token_endpoint: endpoint(context, "/token"),
    jwks_uri: endpoint(context, "/jwks"),
  };
  if (profile.userinfo) doc.userinfo_endpoint = endpoint(context, "/userinfo");
  if (profile.endSession) doc.end_session_endpoint = endpoint(context, "/logout");
  Object.assign(doc, {
    scopes_supported: profile.scopes,
    response_types_supported: ["code"],
    response_modes_supported: ["query", "form_post"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      ...(profile.clientCredentials ? ["client_credentials"] : []),
    ],
    subject_types_supported: [profile.subjectType],
    id_token_signing_alg_values_supported: context.ring.algorithms(),
    token_endpoint_auth_methods_supported: profile.tokenEndpointAuthMethods,
    code_challenge_methods_supported: ["S256"],
    claims_supported: profile.claimsSupported,
    prompt_values_supported: ["none", "login", "consent", "select_account"],
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    authorization_response_iss_parameter_supported: profile.authorizationResponseIss,
  });
  return doc;
}

async function handleJwks(context: IssuerContext): Promise<Response> {
  const { jwksSlow, jwksFailing } = context.standingFaults;
  if (jwksSlow) await delay(jwksSlow === true ? 5000 : jwksSlow.delayMs);
  if (jwksFailing) {
    const status = jwksFailing === true ? 503 : jwksFailing.status;
    return json({ error: "temporarily_unavailable" }, { status });
  }
  return json({ keys: context.ring.publicKeys() }, { cacheSec: 300 });
}

/** A plain coloured disc: the default `picture` of configured personas. No text, nothing to escape. */
function avatar(name: string): Response {
  const hue = Number.parseInt(name.slice(0, 4), 16) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="hsl(${hue} 55% 45%)"/><circle cx="48" cy="38" r="17" fill="#fff" fill-opacity=".85"/><path d="M18 84a30 30 0 0 1 60 0z" fill="#fff" fill-opacity=".85"/></svg>`;
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Content-Security-Policy": "default-src 'none'; style-src 'none'; script-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

function corsOrigins(context: IssuerContext): Set<string> {
  const origins = new Set<string>();
  for (const client of context.clients.values())
    for (const origin of client.corsOrigins) origins.add(origin);
  return origins;
}

async function route(
  context: IssuerContext,
  request: Request,
  allowedOrigins: Set<string>,
): Promise<Response> {
  const url = new URL(request.url);
  const base = context.basePath;
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return notFound();
  const path = url.pathname.slice(base.length);
  const origin = request.headers.get("Origin");
  const cors = (response: Response): Response =>
    origin !== null && allowedOrigins.has(origin) ? withCors(response, origin) : response;

  switch (path) {
    case "/.well-known/openid-configuration":
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      return withCors(json(discoveryDocument(context), { cacheSec: 300 }), "*");
    case "/jwks":
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      return withCors(await handleJwks(context), "*");
    case "/authorize":
      return handleAuthorize(context, request);
    case "/authorize/select":
      return handleSelect(context, request);
    case "/token":
      if (request.method === "OPTIONS" && origin !== null && allowedOrigins.has(origin)) {
        return preflight(origin, ["POST"]);
      }
      return cors(await handleToken(context, request));
    case "/userinfo":
      if (!context.profile.userinfo) return notFound();
      if (request.method === "OPTIONS" && origin !== null && allowedOrigins.has(origin)) {
        return preflight(origin, ["GET", "POST"]);
      }
      return cors(await handleUserinfo(context, request));
    case "/logout":
      if (!context.profile.endSession) return notFound();
      return handleLogout(context, request);
  }
  const avatarMatch = /^\/avatars\/([0-9a-f]{16})\.svg$/.exec(path);
  if (avatarMatch?.[1] && request.method === "GET") return avatar(avatarMatch[1]);
  return notFound();
}

function personaRef(input: MintTokensInput["persona"]): PersonaRef {
  return typeof input === "string"
    ? { id: input }
    : { email: input.email, name: input.name ?? null, verified: input.verified };
}

/**
 * Creates one issuer. Throws `DevIdpConfigError` on invalid configuration and, whatever else is
 * configured, when `environment` is not `development` or `test`.
 *
 * On Workers, construct it inside a request (random values are not available at global scope)
 * and pass `secret` so every isolate seals alike.
 */
export function createDevIdp(options: DevIdpOptions): DevIdp {
  const context = createContext(normalizeConfig(options));
  for (const client of context.clients.values()) {
    const unsupported = client.authMethods.find(
      (method) => !context.profile.tokenEndpointAuthMethods.includes(method),
    );
    if (unsupported !== undefined) {
      throw new DevIdpConfigError(
        `Client ${client.clientId}: the ${context.profile.name} profile does not support ${unsupported}`,
      );
    }
  }
  const allowedOrigins = corsOrigins(context);

  return {
    issuer: context.issuer,
    profile: context.profile.name,
    personas: context.personas,
    clientIds: [...context.clients.keys()],

    async fetch(request) {
      try {
        return await route(context, request, allowedOrigins);
      } catch (error) {
        // Never echo the error: it could carry request data. Log its type and message only.
        log(context, "warn", "request failed", {
          error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
        });
        return oauthError(
          500,
          "server_error",
          "The development issuer failed to handle the request",
        );
      }
    },

    faults: {
      set(faults) {
        const normalized = normalizeFaults(faults);
        if (normalized.codeReplay && !context.store) {
          throw new DevIdpConfigError("Fault codeReplay needs a store");
        }
        context.standingFaults = normalized;
      },
      clear() {
        context.standingFaults = {};
      },
      get active() {
        return { ...context.standingFaults };
      },
    },

    keys: {
      async rotate(alg) {
        const algorithms = alg ? [alg] : context.ring.algorithms();
        const kids: string[] = [];
        for (const algorithm of algorithms) kids.push(await context.ring.rotate(algorithm));
        return kids;
      },
      retire(kid) {
        context.ring.retire(kid);
      },
      jwks() {
        return { keys: context.ring.publicKeys() };
      },
      list() {
        return context.ring.snapshot();
      },
    },

    discovery() {
      return discoveryDocument(context);
    },

    async mintTokens(input) {
      const client = context.clients.get(input.clientId);
      if (!client) throw new DevIdpConfigError(`Unknown client ${input.clientId}`);
      const scopes = input.scope
        ? [...new Set(input.scope.split(" ").filter(Boolean))]
        : client.allowedScopes.filter((scope) => scope !== "offline_access");
      const unknown = scopes.find((scope) => !client.allowedScopes.includes(scope));
      if (unknown !== undefined) throw new DevIdpConfigError(`Scope ${unknown} is not allowed`);
      const now = nowSec(context);
      const grant: Grant = {
        grantId: randomToken(16),
        clientId: client.clientId,
        scopes,
        nonce: input.nonce ?? null,
        authTime: input.authTime ?? now,
        sid: randomToken(16),
        ref: personaRef(input.persona),
        nameIndex: 0,
        offline: true,
        familyExp: now + context.lifetimes.refreshFamilySec,
      };
      const faults = { ...context.standingFaults, ...normalizeFaults(input.faults ?? {}) };
      const refreshToken = refreshAllowed(context, grant)
        ? await sealRefreshToken(context, grant, identityFaultsOf(faults))
        : null;
      const response = await mintTokenResponse(context, client, grant, faults, {
        fromRefresh: false,
        refreshToken,
      });
      if (!response)
        throw new DevIdpConfigError(`Unknown persona ${JSON.stringify(input.persona)}`);
      return response;
    },
  };
}
