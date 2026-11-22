import type { AreaPorts } from "@webflix/core";
import { MemoryEmailSender } from "@webflix/core/memory";
import type { Env } from "../env.ts";
import { type AreaContext, notBuiltYet } from "./shared.ts";

/**
 * The identity area's ports in the Worker: the consumer issuers and the email sender. Owned by
 * the identity area: it adds its adapters here (the generic OIDC relying party, an HTTP email
 * provider, the D1 outbox of local Cloudflare).
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
    identityProviders: {},
    // Per isolate: the mailbox API sees only this isolate's messages (the D1 outbox fixes that).
    email: new MemoryEmailSender({
      clock: context.clock,
      ids: context.ids,
      from: identity.emailFrom,
    }),
  };
}

/**
 * Requests the identity area serves outside the API in the Worker: the development OpenID
 * issuer at `/dev-idp/*` (never in production), built inside a request once per isolate, with a
 * shared `WEBFLIX_DEV_IDP_SECRET` across isolates. Not mounted yet: `packages/dev-idp` does not
 * typecheck under `@cloudflare/workers-types` (WebCrypto's `generateKey`/`exportKey` return
 * unions there: src/jose.ts lines 234 and 257), which the identity area fixes first. Until then
 * `/dev-idp/*` reaches the app and answers `not_found`. Returns null for requests it leaves to
 * the app.
 */
export function handleIdentityRequest(
  _request: Request,
  _env: Env,
  _context: {
    environment: "development" | "test" | "production";
    publicOrigin: string;
    devIdpSecret: string | null;
  },
): Promise<Response> | null {
  return null;
}
