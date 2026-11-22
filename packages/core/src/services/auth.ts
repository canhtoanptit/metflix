import type {
  AuthenticatedSession,
  LoginBody,
  PlanId,
  SessionState,
  SignupBody,
} from "@webflix/contracts";
import { verificationEmailJob } from "../areas/identity/email.ts";
import type { IdentityAccount } from "../areas/identity/repository.ts";
import {
  createSessionIssuer,
  hashSessionToken,
  type IssuedSession,
} from "../areas/identity/sessions.ts";
import type { AreaSeams } from "../areas/module.ts";
import { AppError } from "../errors.ts";
import { serializeError } from "../ports/logger.ts";
import { UniqueViolationError } from "../repositories/ports.ts";
import type { AuthContext, ClientInfo, ServiceDependencies } from "./context.ts";
import { type ChargeCredentialCheck, createCredentialChecks } from "./credentials.ts";
import { isDemoAccount, requireNotDemo } from "./privileges.ts";

export { hashSessionToken, type IssuedSession } from "../areas/identity/sessions.ts";

/** Session tokens: 32 random bytes, base64url (43 chars). Only their SHA-256 is stored. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** `lastSeenAt` is written at most this often per session (it is a write per request otherwise). */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** What the HTTP layer knows about a sign-in attempt beyond its body. */
export interface LoginGuard {
  /** The browser's "known device" cookie, if it sent one. */
  knownDevice?: string | undefined;
  /**
   * Charges one attempt to the email address's budget (`auth-email`), before any hashing.
   * Not called for a browser that signed in to the account before, nor for the demo account
   * (its password is public), so guesses from elsewhere cannot lock an owner out.
   */
  chargeEmail: ChargeCredentialCheck;
}

/**
 * Sign-up with a password (§5.1): the account and a session, without a membership. The plan is
 * chosen and paid at checkout; no card ever reaches this service (principle 4).
 */
export type SignupInput = SignupBody;

export function createAuthService(
  deps: ServiceDependencies,
  seams?: Pick<AreaSeams, "emitServerEvent">,
) {
  const { repos, clock, ids, passwords, logger, jobs } = deps;
  const credentials = createCredentialChecks(deps);
  const sessions = createSessionIssuer(deps);
  // Verifying against a real hash when the email is unknown, or has no password, keeps the
  // response time of "no such account", "no password" and "wrong password" alike (no account
  // enumeration by timing). Kept once computed, never while pending (a promise is not shared
  // between requests).
  let dummyHash: string | undefined;
  const dummy = async (): Promise<string> => {
    dummyHash ??= await passwords.hash("webflix-timing-equaliser");
    return dummyHash;
  };

  async function emit(
    type: "auth.signin" | "auth.signup",
    outcome: "success" | "failure",
    accountId: string | null,
  ): Promise<void> {
    try {
      // A sign-in event carries no profile (§6.1).
      await seams?.emitServerEvent({
        type,
        payload: { method: "password", outcome },
        accountId,
        profileId: null,
      });
    } catch (error) {
      logger.warn("auth.event_failed", { type, error: serializeError(error) });
    }
  }

  /** Remind a new account to verify its address (§4.3); never fails the sign-up. */
  async function queueVerification(accountId: string): Promise<void> {
    try {
      await jobs.publish(verificationEmailJob.create({ accountId }));
    } catch (error) {
      logger.error("auth.verification_not_queued", { accountId, error: serializeError(error) });
    }
  }

  return {
    async emailStatus(email: string): Promise<{ next: "login" | "signup" }> {
      return { next: (await repos.accounts.emailExists(email)) ? "login" : "signup" };
    },

    async signup(body: SignupInput, client: ClientInfo): Promise<IssuedSession> {
      if (await repos.accounts.emailExists(body.email)) {
        await emit("auth.signup", "failure", null);
        throw new AppError("email_already_registered");
      }
      const now = clock.now();
      const passwordHash = await passwords.hash(body.password);
      const accountId = ids.next();
      const session = await sessions.newSession(accountId, client, true);
      const account: IdentityAccount = {
        id: accountId,
        email: body.email,
        passwordHash,
        emailVerifiedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      // The account comes first, without a membership; billing's checkout follows (§5.1).
      try {
        await repos.identity.createAccount({ account, session: session.record, identity: null });
      } catch (error) {
        if (error instanceof UniqueViolationError) throw new AppError("email_already_registered");
        throw error;
      }
      logger.info("auth.signup", { accountId, membership: "none" });
      await queueVerification(accountId);
      await emit("auth.signup", "success", accountId);
      return sessions.issued(session);
    },

    async login(body: LoginBody, client: ClientInfo, guard: LoginGuard): Promise<IssuedSession> {
      const account = await repos.identity.findAccountByEmail(body.email);
      // Unknown addresses are charged like known ones (no enumeration by rate limit).
      const exempt =
        account !== null &&
        (isDemoAccount(account.id) || (await sessions.recognises(guard.knownDevice, account.id)));
      if (!exempt) await guard.chargeEmail();
      // An account created through an issuer has no password: the comparison still runs, against
      // the dummy hash, and its answer is discarded, so no candidate ever signs in to it and the
      // response takes as long as for a wrong password.
      const stored = account?.passwordHash ?? null;
      const verification = await passwords.verify(body.password, stored ?? (await dummy()));
      if (!account || stored === null || !verification.valid) {
        await emit("auth.signin", "failure", account?.id ?? null);
        throw new AppError("invalid_credentials");
      }
      if (verification.needsRehash) {
        // Upgrade the hash (algorithm or cost changed) now that we know the password.
        try {
          await repos.accounts.updatePasswordHash(
            account.id,
            await passwords.hash(body.password),
            clock.now(),
          );
        } catch (error) {
          logger.warn("auth.rehash_failed", {
            accountId: account.id,
            error: serializeError(error),
          });
        }
      }
      const session = await sessions.newSession(account.id, client, body.rememberMe !== false);
      await repos.sessions.create(session.record);
      await emit("auth.signin", "success", account.id);
      return sessions.issued(session);
    },

    /** Resolve a session cookie. Null for missing, malformed, unknown or expired tokens. */
    async authenticate(token: string | null | undefined): Promise<AuthContext | null> {
      if (!token || !TOKEN_PATTERN.test(token)) return null;
      const now = clock.now();
      const found = await repos.sessions.findActive(await hashSessionToken(token), now);
      if (!found) return null;
      if (now - found.session.lastSeenAt >= TOUCH_INTERVAL_MS) {
        try {
          await repos.sessions.touch(found.session.id, now);
          found.session.lastSeenAt = now;
        } catch (error) {
          logger.warn("auth.touch_failed", { error: serializeError(error) });
        }
      }
      return found;
    },

    async logout(auth: AuthContext | null): Promise<void> {
      if (!auth) return;
      await repos.sessions.delete(auth.session.accountId, auth.session.id);
      await deps.streamGate.releaseDevice(auth.session.accountId, auth.session.id);
    },

    async logoutAll(auth: AuthContext): Promise<void> {
      // On the shared demo account it would sign every other visitor out.
      requireNotDemo(auth.session.accountId);
      await repos.sessions.deleteAllForAccount(auth.session.accountId);
      await deps.streamGate.releaseAll(auth.session.accountId);
    },

    async getSession(auth: AuthContext | null): Promise<SessionState> {
      return auth ? sessions.sessionState(auth) : { authenticated: false };
    },

    /**
     * `GET /session`: the bootstrap plus what experiment targeting reads (the plan the account
     * holds, null without one; when it joined), in the same round trips.
     */
    async bootstrap(
      auth: AuthContext | null,
    ): Promise<{ state: SessionState; planId: PlanId | null; joinedAt: number | null }> {
      if (!auth) return { state: { authenticated: false }, planId: null, joinedAt: null };
      return sessions.loadSession(auth);
    },

    sessionState: sessions.sessionState,

    /**
     * Bind a profile to the session (any session may switch, a kids profile included). A PIN
     * submitted for a locked profile is a credential check, charged first; selecting an
     * unlocked profile, or a locked one without a PIN, is not a guess and costs nothing.
     */
    async selectProfile(
      auth: AuthContext,
      body: { profileId: string; pin?: string | undefined },
      charge: ChargeCredentialCheck,
    ): Promise<AuthenticatedSession> {
      const profile = await repos.profiles.get(auth.session.accountId, body.profileId);
      if (!profile) throw new AppError("not_found", { detail: "No such profile" });
      if (profile.pinHash !== null) {
        if (body.pin === undefined) throw new AppError("profile_pin_required");
        await credentials.requirePin(profile, body.pin, charge);
      }
      const bound = await repos.sessions.setActiveProfile(
        auth.session.id,
        auth.session.accountId,
        profile.id,
      );
      if (!bound) throw new AppError("not_found", { detail: "No such profile" });
      return sessions.sessionState({
        session: { ...auth.session, activeProfileId: profile.id },
        profile,
      });
    },

    async clearProfile(auth: AuthContext): Promise<AuthenticatedSession> {
      await repos.sessions.setActiveProfile(auth.session.id, auth.session.accountId, null);
      return sessions.sessionState({
        session: { ...auth.session, activeProfileId: null },
        profile: null,
      });
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
