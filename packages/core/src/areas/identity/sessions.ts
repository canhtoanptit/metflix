import type { Account, AuthenticatedSession, PlanId } from "@webflix/contracts";
import { base64UrlEncode, randomBytes, sha256Hex, utf8Encode } from "../../encoding.ts";
import { AppError } from "../../errors.ts";
import { toIsoString } from "../../ports/clock.ts";
import { createHmacTokenSigner } from "../../ports/token-signer.ts";
import type { SessionRecord } from "../../repositories/records.ts";
import type { AuthContext, ClientInfo, ServiceDependencies } from "../../services/context.ts";
import { describeDevice } from "../../services/device.ts";
import { presentProfile } from "../../services/presenters.ts";
import { isDemoAccount } from "../../services/privileges.ts";
import { sessionMembership } from "../billing/membership.ts";
import type { IdentityAccount } from "./repository.ts";

/** Sign-ins without "remember me" live one day server-side (and in a browser-session cookie). */
const SHORT_SESSION_MS = 24 * 60 * 60 * 1000;
/** A browser that signed in to an account keeps a signed note of it for a year. */
const KNOWN_DEVICE_TTL_SEC = 365 * 24 * 60 * 60;
const KNOWN_DEVICE_PURPOSE = "known-device";

export async function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(utf8Encode(token));
}

/** A signed-in session's bootstrap, with the facts experiment targeting reads from it. */
export interface SessionFacts {
  state: AuthenticatedSession;
  /** The plan the account holds now; null without a membership or once it ended. */
  planId: PlanId | null;
  /** When the account was created (epoch ms). */
  joinedAt: number;
}

export interface IssuedSession {
  /** The cookie value. Never stored. */
  token: string;
  /** Cookie lifetime in seconds; null for a browser-session cookie. */
  maxAgeSec: number | null;
  /**
   * The "known device" cookie: proof that this browser signed in to the account before, which
   * exempts its later sign-ins from the per-email limit. Stateless (signed, never stored).
   */
  knownDevice: { token: string; maxAgeSec: number };
  state: AuthenticatedSession;
}

/** The account as the member sees it, with what the identity area knows of it (§4.1, §4.3). */
export function presentIdentityAccount(account: IdentityAccount): Account {
  return {
    id: account.id,
    email: account.email,
    createdAt: toIsoString(account.createdAt),
    ...(isDemoAccount(account.id) ? { isDemo: true as const } : {}),
    emailVerified: account.emailVerifiedAt !== null,
    hasPassword: account.passwordHash !== null,
  };
}

/**
 * Sessions and what a sign-in hands the browser: shared by password sign-in and sign-up
 * (services/auth.ts) and federated sign-in (the identity area's service).
 */
export function createSessionIssuer(
  deps: Pick<ServiceDependencies, "repos" | "clock" | "ids" | "config">,
) {
  const { repos, clock, ids, config } = deps;
  // Signed with the media token keys under its own purpose: rotating those keys only makes
  // browsers sign in once more before they are recognised again.
  const deviceSigner = createHmacTokenSigner({ keys: config.media.tokenKeys, clock });

  async function knownDevice(accountId: string): Promise<IssuedSession["knownDevice"]> {
    const token = await deviceSigner.sign({
      purpose: KNOWN_DEVICE_PURPOSE,
      exp: Math.floor(clock.now() / 1000) + KNOWN_DEVICE_TTL_SEC,
      a: accountId,
    });
    return { token, maxAgeSec: KNOWN_DEVICE_TTL_SEC };
  }

  /**
   * The session bootstrap and what experiment targeting needs to know about it: the plan the
   * account really holds (null without a membership, or once it has ended: never the stand-in's)
   * and when the account was created.
   */
  async function loadSession(auth: AuthContext): Promise<SessionFacts> {
    // One round trip for identity's part (account, milestone 1 subscription row, profiles).
    const bootstrap = await repos.identity.loadBootstrap(auth.session.accountId);
    if (!bootstrap) throw new AppError("unauthenticated");
    const { account, profiles } = bootstrap;
    const withMembership = bootstrap.subscription ? { subscription: bootstrap.subscription } : null;
    // Billing's part (`subscription`, `plan`, `membership`, `entitlement`): the provider's
    // projection when the account has one, milestone 1's mock membership, or none.
    const membership = await sessionMembership(
      deps,
      account,
      withMembership?.subscription ?? null,
      clock.now(),
    );
    return {
      state: {
        authenticated: true,
        account: presentIdentityAccount(account),
        ...membership,
        profiles: profiles.map(presentProfile),
        activeProfile: auth.profile ? presentProfile(auth.profile) : null,
      },
      planId: membership.entitlement.entitled ? membership.membership.planId : null,
      joinedAt: account.createdAt,
    };
  }

  async function sessionState(auth: AuthContext): Promise<AuthenticatedSession> {
    return (await loadSession(auth)).state;
  }

  return {
    knownDevice,
    sessionState,
    loadSession,

    async recognises(token: string | undefined, accountId: string): Promise<boolean> {
      if (!token) return false;
      const verification = await deviceSigner.verify(token, KNOWN_DEVICE_PURPOSE);
      return verification.valid && verification.claims.a === accountId;
    },

    /** A new device session (not stored yet) and the cookie token that opens it. */
    async newSession(
      accountId: string,
      client: ClientInfo,
      persistent: boolean,
    ): Promise<{ record: SessionRecord; token: string; maxAgeSec: number | null }> {
      const token = base64UrlEncode(randomBytes(32));
      const now = clock.now();
      const device = describeDevice(client.userAgent);
      const lifetimeMs = persistent ? config.session.ttlSec * 1000 : SHORT_SESSION_MS;
      return {
        token,
        maxAgeSec: persistent ? config.session.ttlSec : null,
        record: {
          id: ids.next(),
          tokenHash: await hashSessionToken(token),
          accountId,
          activeProfileId: null,
          deviceLabel: device.label,
          deviceType: device.type,
          persistent,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: now + lifetimeMs,
        },
      };
    },

    /** What the HTTP layer sets after a stored session: cookies and the bootstrap state. */
    async issued(session: {
      record: SessionRecord;
      token: string;
      maxAgeSec: number | null;
    }): Promise<IssuedSession> {
      return {
        token: session.token,
        maxAgeSec: session.maxAgeSec,
        knownDevice: await knownDevice(session.record.accountId),
        state: await sessionState({ session: session.record, profile: null }),
      };
    },
  };
}

export type SessionIssuer = ReturnType<typeof createSessionIssuer>;
