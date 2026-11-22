import {
  type AreaPorts,
  ConfigError,
  createClaimStore,
  createIdentityProviders,
  createOutboxEmailSender,
  type DevelopmentIssuers,
  type EmailSender,
  type Logger,
} from "@webflix/core";
import { MemoryEmailSender } from "@webflix/core/memory";
import { createIdentityRepository } from "@webflix/db";
import { createWebflixDevIdp, type DevIdpHost, WEBFLIX_DEV_CLIENTS } from "@webflix/dev-idp";
import { createHttpEmailSender } from "@webflix/email";
import { createSmtpEmailSender } from "@webflix/email/smtp";
import type { Hono } from "hono";
import type { ApiConfig } from "../config.ts";
import type { AreaContext } from "./shared.ts";

/**
 * One development issuer per runtime configuration: the handler mounted at `/dev-idp/*` and the
 * relying party's in-process calls must be the same issuer (its signing keys and sealed codes).
 */
const devIdps = new WeakMap<ApiConfig, DevIdpHost>();

function developmentIssuer(
  config: ApiConfig,
  logger: Logger,
  store?: ReturnType<typeof createClaimStore>,
): DevIdpHost | null {
  const { core } = config;
  if (core.environment === "production") return null;
  let host = devIdps.get(config);
  if (!host) {
    // Every replica must share the sealing secret; without WEBFLIX_DEV_IDP_SECRET it is derived
    // from the media token key, which every replica already shares (the issuer derives its own
    // keys from it by HKDF, so nothing is reused as is).
    const mediaKey = core.media.tokenKeys[0];
    host = createWebflixDevIdp({
      environment: core.environment,
      origin: core.publicOrigin,
      appOrigins: [core.publicOrigin],
      ...(core.identity.devIdpSecret
        ? { secret: core.identity.devIdpSecret }
        : mediaKey
          ? { secret: `webflix-dev-idp:${mediaKey.secret}` }
          : {}),
      // Single use across replicas: the identity area's claims table.
      ...(store ? { store } : {}),
      logger: {
        info: (msg, fields) => logger.info(msg, fields),
        warn: (msg, fields) => logger.warn(msg, fields),
      },
    });
    devIdps.set(config, host);
  }
  return host;
}

/** The runtime's development issuer, for tests that set standing faults (`idp.faults.set`). */
export function developmentIssuerOf(config: ApiConfig): DevIdpHost | undefined {
  return devIdps.get(config);
}

/** The development issuer's Google and Apple realms, for the relying party, served in process. */
function developmentIssuers(config: ApiConfig, host: DevIdpHost | null): DevelopmentIssuers | null {
  if (!host) return null;
  const base = `${config.core.publicOrigin}/dev-idp`;
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
    case "http": {
      if (!identity.emailHttp)
        throw new ConfigError(["WEBFLIX_EMAIL_SENDER=http needs WEBFLIX_EMAIL_HTTP_API_KEY"]);
      return createHttpEmailSender({
        endpoint: identity.emailHttp.endpoint,
        apiKey: identity.emailHttp.apiKey,
        from: identity.emailFrom,
      });
    }
    case "smtp": {
      if (!identity.smtp)
        throw new ConfigError(["WEBFLIX_EMAIL_SENDER=smtp needs WEBFLIX_SMTP_HOST"]);
      return createSmtpEmailSender({ ...identity.smtp, from: identity.emailFrom });
    }
  }
}

/**
 * The identity area's ports in the Node runtime: the consumer issuers (the generic OpenID relying
 * party per configured issuer; outside production Google and Apple fall back to the development
 * issuer, called in process) and the email sender (memory, SMTP for Mailpit on kind, an HTTP
 * provider, or the database outbox).
 */
export function createIdentityPorts(
  context: AreaContext,
): Pick<AreaPorts, "identityProviders" | "email"> {
  const { config, logger, clock } = context;
  const host = developmentIssuer(
    config,
    logger,
    createClaimStore(createIdentityRepository(context.database), clock),
  );
  const email = emailSender(context);
  if (
    config.core.environment === "production" &&
    (email instanceof MemoryEmailSender || config.core.identity.emailSender === "outbox")
  ) {
    // Verification and reset links would never leave the process: say so at every start.
    logger.warn("identity.email_not_delivered", { sender: config.core.identity.emailSender });
  }
  return {
    identityProviders: createIdentityProviders({
      config: config.core,
      clock,
      logger,
      development: developmentIssuers(config, host),
    }),
    email,
  };
}

/**
 * The development OpenID issuer (packages/dev-idp) at `/dev-idp/{google,apple,staff}`, never in
 * production: the stand-in for Google, Apple and the staff Keycloak realm. Mounted on the root
 * app, ahead of the API's response-header middleware, so its pages keep their own headers. The
 * same issuer the relying party calls in process (one per runtime configuration).
 */
export function mountIdentityRoutes(root: Hono, config: ApiConfig, logger: Logger): void {
  const devIdp = developmentIssuer(config, logger);
  if (!devIdp) return;
  root.all("/dev-idp", (c) => devIdp.fetch(c.req.raw));
  root.all("/dev-idp/*", (c) => devIdp.fetch(c.req.raw));
}
