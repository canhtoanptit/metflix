import type { AuthenticatedSession, LoginBody, SessionState, SignupBody } from "@webflix/contracts";
import { getPlan } from "../domain/plans.ts";
import { base64UrlEncode, randomBytes, sha256Hex, utf8Encode } from "../encoding.ts";
import { AppError } from "../errors.ts";
import { serializeError } from "../ports/logger.ts";
import { createHmacTokenSigner } from "../ports/token-signer.ts";
import { UniqueViolationError } from "../repositories/ports.ts";
import type { SessionRecord } from "../repositories/records.ts";
import type { AuthContext, ClientInfo, ServiceDependencies } from "./context.ts";
import { type ChargeCredentialCheck, createCredentialChecks } from "./credentials.ts";
import { describeDevice } from "./device.ts";
import { presentAccount, presentProfile, presentSubscription } from "./presenters.ts";
import { isDemoAccount, requireNotDemo } from "./privileges.ts";
import { BILLING_PERIOD_MS, type CardInput } from "./subscriptions.ts";

/** Session tokens: 32 random bytes, base64url (43 chars). Only their SHA-256 is stored. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Sign-ins without "remember me" live one day server-side (and in a browser-session cookie). */
const SHORT_SESSION_MS = 24 * 60 * 60 * 1000;
/** `lastSeenAt` is written at most this often per session (it is a write per request otherwise). */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export async function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(utf8Encode(token));
}

/** A browser that signed in to an account keeps a signed note of it for a year. */
const KNOWN_DEVICE_TTL_SEC = 365 * 24 * 60 * 60;
const KNOWN_DEVICE_PURPOSE = "known-device";

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

export function createAuthService(deps: ServiceDependencies) {
  const { repos, clock, ids, passwords, logger, config } = deps;
  const credentials = createCredentialChecks(deps);
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

  async function recognises(token: string | undefined, accountId: string): Promise<boolean> {
    if (!token) return false;
    const verification = await deviceSigner.verify(token, KNOWN_DEVICE_PURPOSE);
    return verification.valid && verification.claims.a === accountId;
  }
  // Verifying against a real hash when the email is unknown keeps the response time of
  // "no such account" and "wrong password" alike (no account enumeration by timing).
  // Kept once computed, never while pending (a promise is not shared between requests).
  let dummyHash: string | undefined;
  const dummy = async (): Promise<string> => {
    dummyHash ??= await passwords.hash("webflix-timing-equaliser");
    return dummyHash;
  };

  async function newSession(
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
  }

  async function sessionState(auth: AuthContext): Promise<AuthenticatedSession> {
    const [loaded, profiles] = await Promise.all([
      repos.accounts.get(auth.session.accountId),
      repos.profiles.list(auth.session.accountId),
    ]);
    if (!loaded) throw new AppError("unauthenticated");
    const now = clock.now();
    return {
      authenticated: true,
      account: presentAccount(loaded.account),
      subscription: presentSubscription(loaded.subscription, now),
      plan: getPlan(loaded.subscription.planId),
      profiles: profiles.map(presentProfile),
      activeProfile: auth.profile ? presentProfile(auth.profile) : null,
    };
  }

  return {
    async emailStatus(email: string): Promise<{ next: "login" | "signup" }> {
      return { next: (await repos.accounts.emailExists(email)) ? "login" : "signup" };
    },

    async signup(
      body: SignupBody & { payment: CardInput },
      client: ClientInfo,
    ): Promise<IssuedSession> {
      if (await repos.accounts.emailExists(body.email))
        throw new AppError("email_already_registered");
      const plan = getPlan(body.planId);
      const now = clock.now();
      // Hashed before the card is charged: nothing that can fail on our side comes after it.
      const passwordHash = await passwords.hash(body.password);
      const charge = await deps.billing.charge({
        card: body.payment,
        amountMinor: plan.monthlyPrice.amountMinor,
        currency: plan.monthlyPrice.currency,
        now,
      });
      if (!charge.approved) {
        throw new AppError("payment_declined", { declineReason: charge.reason });
      }
      const accountId = ids.next();
      const session = await newSession(accountId, client, true);
      try {
        await repos.accounts.createWithSession({
          account: {
            id: accountId,
            email: body.email,
            passwordHash,
            createdAt: now,
            updatedAt: now,
          },
          subscription: {
            accountId,
            planId: plan.id,
            startedAt: now,
            currentPeriodEnd: now + BILLING_PERIOD_MS,
            canceledAt: null,
            card: charge.card,
            updatedAt: now,
          },
          session: session.record,
        });
      } catch (error) {
        if (error instanceof UniqueViolationError) throw new AppError("email_already_registered");
        throw error;
      }
      logger.info("auth.signup", { accountId, planId: plan.id });
      return {
        token: session.token,
        maxAgeSec: session.maxAgeSec,
        knownDevice: await knownDevice(accountId),
        state: await sessionState({ session: session.record, profile: null }),
      };
    },

    async login(body: LoginBody, client: ClientInfo, guard: LoginGuard): Promise<IssuedSession> {
      const account = await repos.accounts.findByEmail(body.email);
      // Unknown addresses are charged like known ones (no enumeration by rate limit).
      const exempt =
        account !== null &&
        (isDemoAccount(account.id) || (await recognises(guard.knownDevice, account.id)));
      if (!exempt) await guard.chargeEmail();
      const verification = await passwords.verify(
        body.password,
        account?.passwordHash ?? (await dummy()),
      );
      if (!account || !verification.valid) throw new AppError("invalid_credentials");
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
      const session = await newSession(account.id, client, body.rememberMe !== false);
      await repos.sessions.create(session.record);
      return {
        token: session.token,
        maxAgeSec: session.maxAgeSec,
        knownDevice: await knownDevice(account.id),
        state: await sessionState({ session: session.record, profile: null }),
      };
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
      return auth ? sessionState(auth) : { authenticated: false };
    },

    sessionState,

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
      return sessionState({
        session: { ...auth.session, activeProfileId: profile.id },
        profile,
      });
    },

    async clearProfile(auth: AuthContext): Promise<AuthenticatedSession> {
      await repos.sessions.setActiveProfile(auth.session.id, auth.session.accountId, null);
      return sessionState({ session: { ...auth.session, activeProfileId: null }, profile: null });
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
