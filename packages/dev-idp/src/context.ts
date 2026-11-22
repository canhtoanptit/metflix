/** What every endpoint of one issuer shares. Built once by `createDevIdp`. */
import type { NormalizedClient, NormalizedConfig } from "./config.ts";
import { epochSeconds, shortTag } from "./encoding.ts";
import type { DevIdpFaults } from "./faults.ts";
import { Sealer } from "./seal.ts";

export interface IssuerContext extends NormalizedConfig {
  sealer: Sealer;
  /** Standing faults: `idp.faults.set` replaces them. */
  standingFaults: DevIdpFaults;
  cookies: {
    session: string;
    csrf: string;
    path: string;
    secure: boolean;
  };
  /**
   * Cosmetic, per-instance memory: sign-in counts (for personas whose name changes) and which
   * personas already authorised which client without a store (Apple's first-authorisation name).
   * Nothing security-relevant lives here.
   */
  local: {
    signIns: Map<string, number>;
    authorised: Set<string>;
  };
}

export function createContext(config: NormalizedConfig): IssuerContext {
  const secure = config.issuerUrl.protocol === "https:";
  // Cookies are scoped to the issuer's path and named after it, so several issuers mounted on
  // one origin (and the application's own cookies) never see each other's.
  const tag = shortTag(config.issuer);
  const prefix = secure ? "__Secure-" : "";
  return {
    ...config,
    sealer: new Sealer({ secret: config.secret, issuer: config.issuer, clock: config.clock }),
    standingFaults: config.faults,
    cookies: {
      session: `${prefix}devidp_${tag}_session`,
      csrf: `${prefix}devidp_${tag}_csrf`,
      path: config.basePath || "/",
      secure,
    },
    local: { signIns: new Map(), authorised: new Set() },
  };
}

export function nowSec(context: IssuerContext): number {
  return epochSeconds(context.clock.now());
}

export function endpoint(context: IssuerContext, path: string): string {
  return `${context.issuer}${path}`;
}

/**
 * How long a revocation marker (revoked grant, ended session) must live: as long as anything it
 * revokes can still be presented (session cookie, refresh-token family, access token).
 */
export function revocationTtlMs(context: IssuerContext): number {
  const { sessionSec, refreshFamilySec, accessTokenSec } = context.lifetimes;
  return Math.max(sessionSec, refreshFamilySec, accessTokenSec) * 1000;
}

/** Store keys are namespaced by issuer, so issuers may share one store. */
export function storeKey(context: IssuerContext, kind: string, id: string): string {
  return `devidp:${shortTag(context.issuer)}:${kind}:${id}`;
}

export function findClient(
  context: IssuerContext,
  clientId: string | undefined,
): NormalizedClient | undefined {
  return clientId === undefined ? undefined : context.clients.get(clientId);
}

/** Logs protocol outcomes. Callers pass identifiers only: never codes, tokens, secrets or state. */
export function log(
  context: IssuerContext,
  level: "info" | "warn",
  message: string,
  fields: Record<string, string | number | boolean | undefined>,
): void {
  context.logger?.[level](`dev-idp: ${message}`, { issuer: context.issuer, ...fields });
}
