import {
  type AreaPorts,
  ConfigError,
  type CoreConfig,
  createClaimStore,
  createIdentityProviders,
  createOutboxEmailSender,
  type DevelopmentIssuers,
  type EmailSender,
  type Logger,
} from "@webflix/core";
import { MemoryEmailSender } from "@webflix/core/memory";
import { createIdentityRepository } from "@webflix/db";
import { createD1Database } from "@webflix/db/d1";
import { createWebflixDevIdp, type DevIdpHost, WEBFLIX_DEV_CLIENTS } from "@webflix/dev-idp";
import { createHttpEmailSender } from "@webflix/email";
import type { Env } from "../env.ts";
import type { AreaContext } from "./shared.ts";

/**
 * One development issuer per isolate (keyed by the bindings object, like the runtime): the
 * handler serving `/dev-idp/*` and the relying party's in-process calls must be the same issuer.
 * Built inside a request (it draws random values), never at module scope.
 */
const devIdps = new WeakMap<Env, DevIdpHost>();

function developmentIssuer(
  env: Env,
  core: Pick<CoreConfig, "environment" | "publicOrigin" | "identity" | "media">,
  logger?: Logger,
): DevIdpHost | null {
  if (core.environment === "production") return null;
  let host = devIdps.get(env);
  if (!host) {
    // Isolates share nothing in memory: the sealing secret comes from configuration
    // (WEBFLIX_DEV_IDP_SECRET, else derived from the media token key every isolate has), and
    // single use is kept in D1, so a code minted by one isolate is redeemed once by any other.
    const mediaKey = core.media.tokenKeys[0];
    const clock = { now: () => Date.now() };
    host = createWebflixDevIdp({
      environment: core.environment,
      origin: core.publicOrigin,
      appOrigins: [core.publicOrigin],
      ...(core.identity.devIdpSecret
        ? { secret: core.identity.devIdpSecret }
        : mediaKey
          ? { secret: `webflix-dev-idp:${mediaKey.secret}` }
          : {}),
      store: createClaimStore(createIdentityRepository(createD1Database(env.DB)), clock),
      ...(logger
        ? {
            logger: {
              info: (msg: string, fields?: Record<string, unknown>) => logger.info(msg, fields),
              warn: (msg: string, fields?: Record<string, unknown>) => logger.warn(msg, fields),
            },
          }
        : {}),
    });
    devIdps.set(env, host);
  }
  return host;
}

function developmentIssuers(
  publicOrigin: string,
  host: DevIdpHost | null,
): DevelopmentIssuers | null {
  if (!host) return null;
  const base = `${publicOrigin}/dev-idp`;
  const { google, apple } = WEBFLIX_DEV_CLIENTS;
  return {
    fetch: (request) => host.fetch(request),
    google: {
      issuer: `${base}/google`,
      clientId: google.clientId,
      clientSecret: google.clientSecret,
    },
    apple: {
      issuer: `${base}/apple`,
      clientId: apple.clientId,
      teamId: apple.teamId,
      keyId: apple.keyId,
      privateKey: apple.privateKey,
    },
  };
}

function emailSender(context: AreaContext): EmailSender {
  const { identity } = context.config.core;
  switch (identity.emailSender) {
    case "memory":
      // Per isolate: the mailbox API sees only this isolate's messages (the D1 outbox fixes that).
      return new MemoryEmailSender({
        clock: context.clock,
        ids: context.ids,
        from: identity.emailFrom,
      });
    case "outbox":
      return createOutboxEmailSender({
        repository: createIdentityRepository(context.database),
        ids: context.ids,
        clock: context.clock,
        from: identity.emailFrom,
      });
    case "http":
      if (!identity.emailHttp)
        throw new ConfigError(["WEBFLIX_EMAIL_SENDER=http needs WEBFLIX_EMAIL_HTTP_API_KEY"]);
      return createHttpEmailSender({
        endpoint: identity.emailHttp.endpoint,
        apiKey: identity.emailHttp.apiKey,
        from: identity.emailFrom,
      });
    case "smtp":
      throw new ConfigError([
        "WEBFLIX_EMAIL_SENDER=smtp: not available in the Worker (no SMTP client on Workers); use http, or outbox locally",
      ]);
  }
}

/**
 * The identity area's ports in the Worker: the consumer issuers (the generic OpenID relying
 * party; outside production Google and Apple use the development issuer, called in process) and
 * the email sender (an HTTP provider, the D1 outbox of local Cloudflare, or memory).
 */
export function createIdentityPorts(
  context: AreaContext,
): Pick<AreaPorts, "identityProviders" | "email"> {
  const { config, logger, clock, env } = context;
  const host = developmentIssuer(env, config.core, logger);
  const email = emailSender(context);
  // The outbox is refused in production by the configuration (it stores live links); memory
  // only keeps them in the isolate.
  if (config.core.environment === "production" && config.core.identity.emailSender !== "http") {
    logger.warn("identity.email_not_delivered", { sender: config.core.identity.emailSender });
  }
  return {
    identityProviders: createIdentityProviders({
      config: config.core,
      clock,
      logger,
      development: developmentIssuers(config.core.publicOrigin, host),
    }),
    email,
  };
}

/**
 * Requests the identity area serves outside the API in the Worker: the development OpenID issuer
 * at `/dev-idp/*` (never in production), ahead of the app so its pages keep their own headers.
 * Returns null for requests it leaves to the app.
 */
export function handleIdentityRequest(
  request: Request,
  env: Env,
  context: Pick<CoreConfig, "environment" | "publicOrigin" | "identity" | "media">,
): Promise<Response> | null {
  if (context.environment === "production") return null;
  const path = new URL(request.url).pathname;
  if (path !== "/dev-idp" && !path.startsWith("/dev-idp/")) return null;
  const host = developmentIssuer(env, context);
  return host ? host.fetch(request) : null;
}

/** The isolate's development issuer, for tests that set standing faults (`idp.faults.set`). */
export function developmentIssuerOf(env: Env): DevIdpHost | undefined {
  return devIdps.get(env);
}
