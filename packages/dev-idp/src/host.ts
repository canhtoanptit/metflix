/**
 * Several issuers under one mount point (`/dev-idp/google`, `/dev-idp/apple`, `/dev-idp/staff`),
 * and the Webflix defaults: the realms every local mode mounts.
 */
import {
  assertNonProductionEnvironment,
  DevIdpConfigError,
  type DevIdpLogger,
  type DevIdpOptions,
} from "./config.ts";
import { DEVELOPMENT_APPLE_CLIENT_KEY } from "./development-keys.ts";
import { json, notFound } from "./http.ts";
import { toPublicJwk } from "./jose.ts";
import { STAFF_ROLE_CLIENT } from "./personas.ts";
import { createDevIdp, type DevIdp } from "./provider.ts";
import type { Clock, DevIdpStore } from "./store.ts";

export type RealmOptions = Omit<DevIdpOptions, "issuer" | "environment">;

export interface DevIdpHostOptions {
  /** `WEBFLIX_ENV`: only `development` and `test` are accepted. */
  environment: string;
  /** The public origin browsers and relying parties reach the host on, e.g. `http://localhost:4000`. */
  origin: string;
  /** Where the host is mounted. Default `/dev-idp`. */
  basePath?: string;
  /** Realm name (`[a-z0-9-]+`) → issuer options. The issuer is `{origin}{basePath}/{realm}`. */
  realms: Readonly<Record<string, RealmOptions>>;
  /** Defaults for every realm that does not set its own. */
  secret?: string;
  store?: DevIdpStore | "memory" | "none";
  clock?: Clock;
  logger?: DevIdpLogger;
}

export interface DevIdpHost {
  fetch(request: Request): Promise<Response>;
  readonly realms: Readonly<Record<string, DevIdp>>;
}

export function createDevIdpHost(options: DevIdpHostOptions): DevIdpHost {
  assertNonProductionEnvironment(options.environment);
  const basePath = options.basePath ?? "/dev-idp";
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(basePath)) {
    throw new DevIdpConfigError(
      `basePath must look like /dev-idp, not ${JSON.stringify(basePath)}`,
    );
  }
  let origin: string;
  try {
    origin = new URL(options.origin).origin;
  } catch {
    throw new DevIdpConfigError(`origin is not a URL: ${options.origin}`);
  }
  if (origin !== options.origin) throw new DevIdpConfigError(`origin must be bare, like ${origin}`);
  const realms: Record<string, DevIdp> = {};
  for (const [name, realm] of Object.entries(options.realms)) {
    if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new DevIdpConfigError(`Invalid realm name ${name}`);
    realms[name] = createDevIdp({
      secret: options.secret,
      store: options.store,
      clock: options.clock,
      logger: options.logger,
      ...realm,
      issuer: `${origin}${basePath}/${name}`,
      environment: options.environment,
    });
  }
  return {
    realms,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === basePath || path === `${basePath}/`) {
        return json({
          note: "Development OpenID issuers. Not for production.",
          issuers: Object.fromEntries(
            Object.entries(realms).map(([name, idp]) => [
              name,
              { issuer: idp.issuer, discovery: `${idp.issuer}/.well-known/openid-configuration` },
            ]),
          ),
        });
      }
      if (!path.startsWith(`${basePath}/`)) return notFound();
      const name = path.slice(basePath.length + 1).split("/")[0] ?? "";
      const idp = Object.hasOwn(realms, name) ? realms[name] : undefined;
      return idp ? idp.fetch(request) : notFound();
    },
  };
}

// --- Webflix defaults ----------------------------------------------------------------------------

/**
 * DEVELOPMENT ONLY. The client registrations the default realms ship with: the relying party's
 * local configuration uses these values (published on purpose, like every development default).
 */
export const WEBFLIX_DEV_CLIENTS = {
  google: {
    clientId: "webflix-web",
    clientSecret: "dev-only-google-client-secret",
    /** Relative to each origin. */
    callbackPath: "/api/v1/auth/oidc/google/callback",
  },
  apple: {
    clientId: "dev.webflix.web",
    teamId: "DEVTEAM001",
    keyId: "DEVKEY0001",
    /** The relying party signs its client secret with this (ES256), as with a key from Apple. */
    privateKey: DEVELOPMENT_APPLE_CLIENT_KEY,
    callbackPath: "/api/v1/auth/oidc/apple/callback",
  },
  staff: {
    clientId: STAFF_ROLE_CLIENT,
    /** `aud` of staff access tokens: what the admin API checks. */
    audience: "webflix-admin-api",
    callbackPath: "/admin/auth/callback",
    postLogoutPath: "/admin/",
  },
} as const;

export interface WebflixRealmsInput {
  /** Every origin the web app or admin console is served from locally (redirect URIs are exact). */
  appOrigins: readonly string[];
}

/** The three realms of every local mode: Google-like and Apple-like consumers, and staff. */
export function webflixRealms(
  input: WebflixRealmsInput,
): Record<"google" | "apple" | "staff", RealmOptions> {
  const at = (path: string) => input.appOrigins.map((origin) => `${new URL(origin).origin}${path}`);
  const { google, apple, staff } = WEBFLIX_DEV_CLIENTS;
  return {
    google: {
      profile: "google",
      clients: [
        {
          clientId: google.clientId,
          displayName: "Webflix",
          clientSecret: google.clientSecret,
          tokenEndpointAuthMethods: ["client_secret_basic", "client_secret_post"],
          redirectUris: at(google.callbackPath),
        },
      ],
    },
    apple: {
      profile: "apple",
      clients: [
        {
          clientId: apple.clientId,
          displayName: "Webflix",
          signedClientSecret: {
            teamId: apple.teamId,
            keyId: apple.keyId,
            publicKey: toPublicJwk(apple.privateKey),
          },
          redirectUris: at(apple.callbackPath),
        },
      ],
    },
    staff: {
      profile: "keycloak",
      clients: [
        {
          clientId: staff.clientId,
          displayName: "Webflix admin console",
          redirectUris: at(staff.callbackPath),
          postLogoutRedirectUris: at(staff.postLogoutPath),
          accessTokenAudience: [staff.audience, "account"],
        },
      ],
    },
  };
}

export interface WebflixDevIdpOptions extends Omit<DevIdpHostOptions, "realms"> {
  /** Defaults to `[origin]`. */
  appOrigins?: readonly string[];
}

/** The host every local mode mounts at `/dev-idp/*` when `WEBFLIX_ENV` is not production. */
export function createWebflixDevIdp(options: WebflixDevIdpOptions): DevIdpHost {
  return createDevIdpHost({
    ...options,
    realms: webflixRealms({ appOrigins: options.appOrigins ?? [options.origin] }),
  });
}
