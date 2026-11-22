import type { OidcProvider } from "@webflix/contracts";
import { ConfigError, type CoreConfig } from "../../config.ts";
import type { Clock } from "../../ports/clock.ts";
import type { IdentityProvider, IdentityProviders } from "../../ports/identity-provider.ts";
import type { Logger } from "../../ports/logger.ts";
import type { Es256PrivateKey } from "./jose.ts";
import {
  createOidcIdentityProvider,
  type OidcClientAuthentication,
  type OidcFetch,
} from "./oidc.ts";

/**
 * The development issuer's consumer realms, served in process (`/dev-idp/google`,
 * `/dev-idp/apple`): the stand-ins for Google and Apple outside production. The relying party
 * calls them through `fetch` (the mounted issuer's handler), never over the network, so a mode
 * works before any proxy routes `/dev-idp` to it.
 */
export interface DevelopmentIssuers {
  fetch: OidcFetch;
  google: { issuer: string; clientId: string; clientSecret: string };
  apple: {
    issuer: string;
    clientId: string;
    teamId: string;
    keyId: string;
    privateKey: Es256PrivateKey;
  };
}

const DISPLAY_NAMES: Record<OidcProvider, string> = {
  google: "Google",
  apple: "Apple",
  keycloak: "Keycloak",
};

/** What each provider is asked for: Apple has no `profile` scope, and answers with a form post. */
const SCOPES: Record<OidcProvider, readonly string[]> = {
  google: ["openid", "email", "profile"],
  apple: ["openid", "email", "name"],
  keycloak: ["openid", "email", "profile"],
};

/**
 * The consumer issuers this deployment offers (`WEBFLIX_OIDC_PROVIDERS`), from configuration:
 * a configured client is used as is (Google, Apple, Keycloak: a matter of configuration only);
 * outside production, Google and Apple without a client use the development issuer. In
 * production an offered issuer without a client is not offered (logged), or, when
 * `WEBFLIX_OIDC_PROVIDERS` names it explicitly, a startup error.
 */
export function createIdentityProviders(input: {
  config: CoreConfig;
  clock: Clock;
  logger: Logger;
  development: DevelopmentIssuers | null;
  /** Network access to real issuers. Default: global fetch. */
  fetch?: OidcFetch;
}): IdentityProviders {
  const { config, clock, logger, development } = input;
  const identity = config.identity;
  if (identity.identityProvider !== "oidc") return {};
  const production = config.environment === "production";
  const offered: IdentityProviders = {};
  const missing: string[] = [];
  for (const provider of identity.oidcProviders) {
    const client = identity.oidcClients[provider];
    let created: IdentityProvider | null = null;
    if (client) {
      const auth = client.authentication;
      const clientAuthentication: OidcClientAuthentication =
        auth.method === "apple_client_secret"
          ? {
              method: "apple_client_secret",
              teamId: auth.teamId,
              keyId: auth.keyId,
              privateKey: auth.privateKey,
            }
          : auth;
      created = createOidcIdentityProvider({
        id: provider,
        displayName: DISPLAY_NAMES[provider],
        issuer: client.issuer,
        clientId: client.clientId,
        clientAuthentication,
        scopes: SCOPES[provider],
        responseMode: provider === "apple" ? "form_post" : "query",
        reportsAuthTime: client.reportsAuthTime,
        clock,
        timeoutMs: identity.oidcTimeoutMs,
        jwksRefetchCooldownSec: identity.oidcJwksRefetchCooldownSec,
        // A local Keycloak (kind) may be plain http; production issuers never are.
        allowHttp: !production,
        ...(input.fetch ? { fetch: input.fetch } : {}),
      });
    } else if (!production && development && (provider === "google" || provider === "apple")) {
      const realm = development[provider];
      created = createOidcIdentityProvider({
        id: provider,
        displayName: DISPLAY_NAMES[provider],
        issuer: realm.issuer,
        clientId: realm.clientId,
        clientAuthentication:
          provider === "apple"
            ? {
                method: "apple_client_secret",
                teamId: development.apple.teamId,
                keyId: development.apple.keyId,
                privateKey: development.apple.privateKey,
              }
            : { method: "client_secret_basic", secret: development.google.clientSecret },
        scopes: SCOPES[provider],
        responseMode: provider === "apple" ? "form_post" : "query",
        // The development issuer always sends auth_time (the fault catalogue removes it).
        reportsAuthTime: true,
        clock,
        timeoutMs: identity.oidcTimeoutMs,
        jwksRefetchCooldownSec: identity.oidcJwksRefetchCooldownSec,
        allowHttp: true,
        fetch: development.fetch,
      });
    }
    if (created) offered[provider] = created;
    else missing.push(provider);
  }
  if (missing.length > 0) {
    if (production && identity.oidcProvidersExplicit) {
      throw new ConfigError(
        missing.map(
          (provider) =>
            `WEBFLIX_OIDC_PROVIDERS offers ${provider}, but WEBFLIX_OIDC_${provider.toUpperCase()}_CLIENT_ID is not set`,
        ),
      );
    }
    logger.warn("identity.providers_not_offered", { providers: missing });
  }
  return offered;
}
