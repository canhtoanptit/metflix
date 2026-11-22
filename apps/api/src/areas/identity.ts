import type { AreaPorts, Logger } from "@webflix/core";
import { MemoryEmailSender } from "@webflix/core/memory";
import { createWebflixDevIdp } from "@webflix/dev-idp";
import type { Hono } from "hono";
import type { ApiConfig } from "../config.ts";
import { type AreaContext, notBuiltYet } from "./shared.ts";

/**
 * The identity area's ports in the Node runtime: the consumer issuers and the email sender.
 * Owned by the identity area: it adds its adapters here (the generic OIDC relying party
 * against `WEBFLIX_OIDC_*`, SMTP for Mailpit on kind, an HTTP provider).
 */
export function createIdentityPorts(
  context: AreaContext,
): Pick<AreaPorts, "identityProviders" | "email"> {
  const { identity } = context.config.core;
  if (identity.identityProvider !== "memory") {
    notBuiltYet("WEBFLIX_IDENTITY_PROVIDER", identity.identityProvider, "identity");
  }
  if (identity.emailSender !== "memory") {
    notBuiltYet("WEBFLIX_EMAIL_SENDER", identity.emailSender, "identity");
  }
  return {
    // No consumer issuer until the relying party exists: the start routes answer not_implemented.
    identityProviders: {},
    email: new MemoryEmailSender({
      clock: context.clock,
      ids: context.ids,
      from: identity.emailFrom,
    }),
  };
}

/**
 * The development OpenID issuer (packages/dev-idp) at `/dev-idp/{google,apple,staff}`, never in
 * production: the stand-in for Google, Apple and the staff Keycloak realm. Mounted on the root
 * app, ahead of the API's response-header middleware, so its pages keep their own headers.
 * Several replicas need a shared `WEBFLIX_DEV_IDP_SECRET` (and, for strict single use across
 * them, a shared store: the identity area's work).
 */
export function mountIdentityRoutes(root: Hono, config: ApiConfig, logger: Logger): void {
  const { core } = config;
  if (core.environment === "production") return;
  const devIdp = createWebflixDevIdp({
    environment: core.environment,
    origin: core.publicOrigin,
    appOrigins: [core.publicOrigin],
    ...(core.identity.devIdpSecret ? { secret: core.identity.devIdpSecret } : {}),
    logger: {
      info: (msg, fields) => logger.info(msg, fields),
      warn: (msg, fields) => logger.warn(msg, fields),
    },
  });
  root.all("/dev-idp/*", (c) => devIdp.fetch(c.req.raw));
}
