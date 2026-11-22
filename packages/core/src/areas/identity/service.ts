import {
  API_BASE_PATH,
  ELEVATION_TTL_SEC,
  type Elevation,
  EMAIL_VERIFICATION_TTL_SEC,
  type ErrorCode,
  type IdentityList,
  type LinkedIdentity,
  type Mailbox,
  type MaturityLevel,
  OIDC_ERROR_PARAM,
  OIDC_PROVIDERS,
  OIDC_RESULT_PARAM,
  type OidcIntent,
  type OidcOutcome,
  type OidcProvider,
  PASSWORD_RESET_TTL_SEC,
  type REAUTH_METHODS,
  ReturnPath,
  type SignInProviders,
  type WebhookAck,
} from "@webflix/contracts";
import { type EmailTemplateData, EmailWebhookError, parseResendWebhook } from "@webflix/email";
import * as z from "zod";
import { decodeCursor, encodeCursor } from "../../domain/cursor.ts";
import {
  base64UrlEncode,
  randomBytes,
  sha256Hex,
  timingSafeEqual,
  utf8Encode,
} from "../../encoding.ts";
import { AppError } from "../../errors.ts";
import { toIsoString } from "../../ports/clock.ts";
import { type EmailTemplate, emailLinks, isLocalMailbox } from "../../ports/email-sender.ts";
import {
  createPkceVerifier,
  IdentityProviderError,
  pkceChallenge,
  type VerifiedIdentity,
} from "../../ports/identity-provider.ts";
import { handleJob, type JobBinding } from "../../ports/job-queue.ts";
import { serializeError } from "../../ports/logger.ts";
import { UniqueViolationError } from "../../repositories/ports.ts";
import type { AuthContext, ClientInfo, ServiceDependencies } from "../../services/context.ts";
import { createCredentialChecks } from "../../services/credentials.ts";
import { isDemoAccount, requireAccountHolder, requireNotDemo } from "../../services/privileges.ts";
import type { AreaModule, AreaSeams } from "../module.ts";
import {
  type EmailRequest,
  identityCleanupJob,
  passwordResetEmailJob,
  sendEmailJob,
  sendTemplatedEmail,
  verificationEmailJob,
} from "./email.ts";
import type { IdentityAccount, LinkedIdentityRecord } from "./repository.ts";
import { createSealer } from "./seal.ts";
import { createSessionIssuer, type IssuedSession } from "./sessions.ts";

/** How long a federated sign-in may take at the issuer (its sign-in page lives as long). */
export const OIDC_TRANSACTION_TTL_SEC = 10 * 60;
/** Claims and spent tokens deleted per cleanup job. */
const CLEANUP_BATCH = 500;
const MAILBOX_LIMIT = 100;

/** Charges one email to an address (`email-send-recipient`), before anything is looked up. */
export type ChargeRecipient = (address: string) => Promise<void>;

export interface OidcStart {
  /** The issuer's authorisation URL. */
  location: string;
  /**
   * The sealed transaction: the browser's cookie, the only state of the flow. Null when the
   * issuer could not be reached: `location` then sends the browser back with `?oidc=failed`.
   */
  transaction: string | null;
  maxAgeSec: number;
  /** A form-post issuer (Apple) answers with a cross-site POST: the cookie must be SameSite=None. */
  crossSite: boolean;
}

export interface OidcCompletion {
  /** Where the browser goes next: the transaction's `returnTo` with `?oidc=<outcome>`. */
  location: string;
  outcome: OidcOutcome;
  /** A new session for `signed-in` and `signed-up`. */
  session: IssuedSession | null;
}

/** What a staff member sees of a member's identity (the admin area adds the membership). */
export interface MemberIdentity {
  account: {
    id: string;
    email: string;
    emailVerified: boolean;
    hasPassword: boolean;
    createdAt: string;
    isDemo: boolean;
  };
  identities: LinkedIdentity[];
  profiles: Array<{
    id: string;
    name: string;
    isKids: boolean;
    maturityCeiling: MaturityLevel;
    locked: boolean;
  }>;
  activeDevices: number;
}

export interface MemberIdentitySummary {
  accountId: string;
  email: string;
  createdAt: string;
  isDemo: boolean;
}

/**
 * The identity area (milestone 2 §4, §8.2): federated sign-in through `deps.identityProviders`,
 * linked identities, the account-holder proof (`sessions.elevated_until`, granted only through
 * services/credentials.ts), email verification, password reset, and email through `deps.email`
 * as jobs with idempotency keys. Emits `auth.signin` / `auth.signup` through
 * `seams.emitServerEvent`. Milestone 1's sign-in, profiles and devices (services/auth.ts,
 * profiles.ts, credentials.ts, privileges.ts) are this area's too.
 */
export interface IdentityService extends AreaModule {
  startOidc(input: {
    provider: OidcProvider;
    intent: OidcIntent;
    returnTo: string;
    auth: AuthContext | null;
  }): Promise<OidcStart>;
  completeOidc(input: {
    provider: OidcProvider;
    response: {
      code?: string | undefined;
      state?: string | undefined;
      iss?: string | undefined;
      error?: string | undefined;
    };
    transaction: string | undefined;
    client: ClientInfo;
  }): Promise<OidcCompletion>;
  /** The issuers offered, in button order: key and display name only (configuration, no I/O). */
  signInProviders(): SignInProviders;
  /**
   * Where a callback the handler never ran for (refused by validation or the rate limit) sends
   * the browser: its transaction's `returnTo`, if the cookie opens, with `?oidc=failed` (and
   * `oidcError=<error>` when given). Opens the cookie only (nothing is claimed or stored); the
   * transaction is abandoned either way.
   */
  abandonedCallbackLocation(
    provider: string,
    transaction: string | undefined,
    error?: ErrorCode,
  ): Promise<string>;
  /**
   * Where a refused start sends a browser navigation (it must not land on a problem document):
   * the `returnTo` it asked for when that is a valid same-origin path, `/` otherwise, with
   * `?oidc=failed&oidcError=<error>`. Configuration only, no I/O.
   */
  refusedStartLocation(returnTo: string | undefined, error: ErrorCode): string;
  /** The cookie name of a provider's transaction (one per provider, so two tabs do not collide). */
  transactionCookieName(provider: string, secure: boolean): string;
  listIdentities(auth: AuthContext): Promise<IdentityList>;
  unlinkIdentity(auth: AuthContext, provider: OidcProvider): Promise<void>;
  getElevation(auth: AuthContext): Promise<Elevation>;
  /** The password proof. The request was already charged to `profile-pin` (request-scoped route). */
  elevate(auth: AuthContext, password: string): Promise<Elevation>;
  requestEmailVerification(auth: AuthContext, charge: ChargeRecipient): Promise<void>;
  confirmEmailVerification(token: string): Promise<void>;
  requestPasswordReset(email: string, charge: ChargeRecipient): Promise<void>;
  confirmPasswordReset(token: string, newPassword: string): Promise<void>;
  receiveEmailWebhook(
    provider: string,
    headers: { get(name: string): string | null },
    body: Uint8Array,
  ): Promise<WebhookAck>;
  mailbox(query: { to: string; since?: string | undefined }): Promise<Mailbox>;
  /** Queue a templated email (the seam for other areas: receipts, trial reminders, exports). */
  sendEmail(request: EmailRequest): Promise<void>;

  // --- Staff support (the admin area wires the routes, roles and audit entries) --------------
  searchMembers(input: {
    q: string;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<{
    items: MemberIdentitySummary[];
    nextCursor: string | null;
  }>;
  getMemberIdentity(accountId: string): Promise<MemberIdentity>;
  /** Ends every session and stream of the account; how many sessions ended. */
  signOutMemberEverywhere(accountId: string): Promise<{ sessionsEnded: number }>;
  /** Emails the member a reset link (the same job as `POST /auth/password-reset`). */
  sendMemberPasswordReset(accountId: string): Promise<{ email: string }>;
  /** Removes a profile's PIN; whether it had one (the audit entry's before/after). */
  removeMemberProfilePin(accountId: string, profileId: string): Promise<{ hadPin: boolean }>;
}

const Transaction = z.strictObject({
  v: z.literal(1),
  id: z.string().min(16).max(64),
  p: z.string(),
  i: z.enum(["signin", "link", "reauth"]),
  s: z.string().min(16).max(128),
  n: z.string().min(16).max(128),
  c: z.string().min(43).max(128),
  m: z.number().int().nonnegative().optional(),
  r: z.string().max(512),
  sid: z.string().max(64).optional(),
  a: z.string().max(64).optional(),
  exp: z.number(),
});
type Transaction = z.output<typeof Transaction>;

const SearchCursor = z.object({ e: z.string(), i: z.string() });

const randomToken = () => base64UrlEncode(randomBytes(32));
const hashToken = (token: string) => sha256Hex(utf8Encode(token));
const sameString = (a: string, b: string) => {
  const left = utf8Encode(a);
  const right = utf8Encode(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Why a federated sign-in failed, for the logs only (members see `failed`). */
class OidcFailure extends Error {
  override readonly name = "OidcFailure";
  readonly outcome: OidcOutcome;

  constructor(reason: string, outcome: OidcOutcome = "failed") {
    super(reason);
    this.outcome = outcome;
  }
}

export function createIdentityService(
  deps: ServiceDependencies,
  seams: AreaSeams,
): IdentityService {
  const { repos, clock, ids, config, logger, jobs, passwords, streamGate } = deps;
  const credentials = createCredentialChecks(deps);
  const sessions = createSessionIssuer(deps);
  const origin = config.publicOrigin;
  const transactions = createSealer(config.media.tokenKeys, "oidc-transaction");
  const providers = () => deps.identityProviders;

  const callbackUri = (provider: OidcProvider) =>
    `${origin}${API_BASE_PATH}/auth/oidc/${provider}/callback`;

  function withOutcome(returnTo: string, outcome: OidcOutcome, error?: ErrorCode): string {
    let url = new URL(returnTo, origin);
    // The return path was validated as same-origin at the start; never follow anything else.
    if (url.origin !== origin) url = new URL("/", origin);
    url.searchParams.set(OIDC_RESULT_PARAM, outcome);
    if (error !== undefined) url.searchParams.set(OIDC_ERROR_PARAM, error);
    return url.href;
  }

  async function emit(
    type: "auth.signin" | "auth.signup",
    method: "password" | "oidc",
    outcome: "success" | "failure",
    accountId: string | null,
  ): Promise<void> {
    try {
      // A sign-in event carries no profile (§6.1).
      await seams.emitServerEvent({
        type,
        payload: { method, outcome },
        accountId,
        profileId: null,
      });
    } catch (error) {
      logger.warn("identity.event_failed", { type, error: serializeError(error) });
    }
  }

  async function queueEmail<T extends EmailTemplate>(
    to: string,
    template: T,
    data: EmailTemplateData[T],
    key: string,
  ): Promise<void> {
    try {
      await jobs.publish(
        sendEmailJob.create({ to, template, data: data as Record<string, unknown>, key }),
      );
    } catch (error) {
      // An alert that cannot be queued must not undo what already happened; it is logged.
      logger.error("identity.email_not_queued", { template, error: serializeError(error) });
    }
  }

  const securityAlert = (
    account: Pick<IdentityAccount, "id" | "email">,
    change: EmailTemplateData["security-change"]["change"],
    detail: string | null,
    key: string,
  ) =>
    queueEmail(
      account.email,
      "security-change",
      { change, at: toIsoString(clock.now()), detail, manageUrl: `${origin}/account` },
      `security:${account.id}:${change}:${key}`,
    );

  /** Render and send one message, unless the address bounced or complained before. */
  async function deliver(
    to: string,
    template: EmailTemplate,
    data: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<void> {
    // Job payloads carry the data as JSON; the template validates what it renders.
    await sendTemplatedEmail(deps, { to, template, data: data as never, idempotencyKey });
  }

  async function mintLink(
    account: IdentityAccount,
    purpose: "verify_email" | "reset_password",
  ): Promise<{ link: string; expiresAt: string }> {
    const token = randomToken();
    const now = clock.now();
    const ttlSec = purpose === "verify_email" ? EMAIL_VERIFICATION_TTL_SEC : PASSWORD_RESET_TTL_SEC;
    await repos.identity.createToken({
      tokenHash: await hashToken(token),
      accountId: account.id,
      purpose,
      email: account.email,
      expiresAt: now + ttlSec * 1000,
      usedAt: null,
      createdAt: now,
    });
    // In the fragment: never sent to a server, never in an access log or a Referer.
    const page = purpose === "verify_email" ? "verify-email" : "reset-password";
    return {
      link: `${origin}/${page}#token=${token}`,
      expiresAt: toIsoString(now + ttlSec * 1000),
    };
  }

  const jobBindings: JobBinding[] = [
    handleJob(sendEmailJob, async (payload) => {
      await deliver(payload.to, payload.template, payload.data, payload.key);
    }),
    handleJob(verificationEmailJob, async (payload, context) => {
      const account = await repos.identity.getAccount(payload.accountId);
      if (!account || account.emailVerifiedAt !== null || isDemoAccount(account.id)) return;
      const { link, expiresAt } = await mintLink(account, "verify_email");
      await deliver(
        account.email,
        "verify-email",
        { link, expiresAt },
        `verify-email:${context.id}`,
      );
    }),
    handleJob(passwordResetEmailJob, async (payload, context) => {
      const account = await repos.identity.findAccountByEmail(payload.email.trim().toLowerCase());
      // No account (or the shared demo account): nothing is sent, and the request that queued
      // this already answered exactly as it would have otherwise.
      if (!account || isDemoAccount(account.id)) return;
      const { link, expiresAt } = await mintLink(account, "reset_password");
      await deliver(
        account.email,
        "reset-password",
        { link, expiresAt },
        `reset-password:${context.id}`,
      );
    }),
    handleJob(identityCleanupJob, async (_payload, context) => {
      const deleted = await repos.identity.deleteExpired(clock.now(), CLEANUP_BATCH);
      context.logger.info("identity.cleaned_up", { deleted });
      if (deleted >= CLEANUP_BATCH) await jobs.publish(identityCleanupJob.create({}));
    }),
  ];

  async function openTransaction(
    provider: OidcProvider,
    sealed: string | undefined,
  ): Promise<Transaction> {
    if (!sealed) throw new OidcFailure("transaction_missing");
    const parsed = Transaction.safeParse(await transactions.open(sealed, `oidc:${provider}`));
    if (!parsed.success) throw new OidcFailure("transaction_invalid");
    const tx = parsed.data;
    if (tx.p !== provider) throw new OidcFailure("transaction_provider_mismatch");
    return tx;
  }

  /** The live session a link or reauth transaction was started from. */
  async function boundSession(tx: Transaction) {
    if (!tx.sid || !tx.a) throw new OidcFailure("transaction_unbound");
    const found = await repos.identity.getSession(tx.sid, clock.now());
    if (!found || found.session.accountId !== tx.a) throw new OidcFailure("session_gone");
    return found;
  }

  async function startSession(accountId: string, client: ClientInfo): Promise<IssuedSession> {
    const session = await sessions.newSession(accountId, client, true);
    await repos.sessions.create(session.record);
    return sessions.issued(session);
  }

  function identityRecord(
    identity: VerifiedIdentity,
    accountId: string,
    now: number,
  ): LinkedIdentityRecord {
    return {
      provider: identity.provider,
      subject: identity.subject,
      accountId,
      issuer: identity.issuer,
      emailAtLink: identity.email,
      createdAt: now,
      lastUsedAt: now,
    };
  }

  /**
   * Sign in, or sign up, with a verified issuer identity (§4.1). The linking rule:
   * - an identity already linked signs in to its account (keyed by issuer and subject only);
   * - otherwise an account with the asserted address is linked automatically only when the
   *   issuer verified the address AND the account's address is verified (and it is not the
   *   shared demo account) AND the identity was never removed from an account (unlinked by the
   *   member, or dropped by a password reset); anything less is `link-required`: sign in first,
   *   then link deliberately;
   * - with no such account, a new one is created (membership `none`), only for an address the
   *   issuer verified, so nobody can squat an address they do not control.
   */
  async function signInOrUp(
    identity: VerifiedIdentity,
    client: ClientInfo,
  ): Promise<OidcCompletion & { accountId: string }> {
    const now = clock.now();
    const linked = await repos.identity.findIdentity(identity.provider, identity.subject);
    if (linked) {
      // An identity from one issuer is never honoured for another configured under the same
      // provider name (a development issuer's subjects are shaped like the real ones).
      if (linked.issuer !== identity.issuer) throw new OidcFailure("identity_issuer_changed");
      await repos.identity.touchIdentity(identity.provider, identity.subject, now);
      if (identity.email !== null && identity.emailVerified) {
        await repos.identity.markEmailVerified(linked.accountId, identity.email, now);
      }
      return {
        outcome: "signed-in",
        location: "",
        session: await startSession(linked.accountId, client),
        accountId: linked.accountId,
      };
    }
    if (identity.email === null) throw new OidcFailure("email_missing");
    const existing = await repos.identity.findAccountByEmail(identity.email);
    if (existing) {
      const automatic =
        identity.emailVerified && existing.emailVerifiedAt !== null && !isDemoAccount(existing.id);
      if (!automatic) throw new OidcFailure("link_not_automatic", "link-required");
      // An identity removed from an account (the member unlinked it, or a password reset dropped
      // it) never comes back by itself: only the deliberate, proven link (intent=link).
      if (await repos.identity.findRemoval(identity.provider, identity.subject)) {
        throw new OidcFailure("identity_removed", "link-required");
      }
      let added: boolean;
      try {
        added = await repos.identity.linkIdentity(identityRecord(identity, existing.id, now));
      } catch (error) {
        if (error instanceof UniqueViolationError)
          throw new OidcFailure("identity_raced", "identity-in-use");
        throw error;
      }
      // The account already has another identity of this provider (a changed subject): never
      // replace it silently.
      if (!added) throw new OidcFailure("provider_already_linked", "link-required");
      await securityAlert(
        existing,
        "identity-linked",
        `${identity.provider} sign-in was linked.`,
        identity.subject,
      );
      return {
        outcome: "signed-in",
        location: "",
        session: await startSession(existing.id, client),
        accountId: existing.id,
      };
    }
    if (!identity.emailVerified) throw new OidcFailure("email_unverified");
    const accountId = ids.next();
    const session = await sessions.newSession(accountId, client, true);
    try {
      await repos.identity.createAccount({
        account: {
          id: accountId,
          email: identity.email,
          passwordHash: null,
          emailVerifiedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        session: session.record,
        identity: identityRecord(identity, accountId, now),
      });
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        throw new OidcFailure(
          `signup_raced_${error.field}`,
          error.field === "email" ? "link-required" : "failed",
        );
      }
      throw error;
    }
    logger.info("auth.signup", { accountId, method: "oidc", provider: identity.provider });
    await queueEmail(
      identity.email,
      "welcome",
      { signInMethod: providerName(identity.provider) },
      `welcome:${accountId}`,
    );
    return {
      outcome: "signed-up",
      location: "",
      session: await sessions.issued(session),
      accountId,
    };
  }

  function providerName(provider: OidcProvider): string {
    return providers()[provider]?.displayName ?? provider;
  }

  /** Attach the identity to the account that started the flow (elevated, at the start). */
  async function link(identity: VerifiedIdentity, tx: Transaction): Promise<OidcOutcome> {
    const { session } = await boundSession(tx);
    const accountId = session.accountId;
    if (isDemoAccount(accountId)) throw new OidcFailure("demo_account");
    // Only an identity whose address its issuer verified may be linked: the password reset rule
    // (identities linked under another address are dropped) relies on it.
    if (identity.email === null || !identity.emailVerified)
      throw new OidcFailure("link_email_unverified");
    const linked = await repos.identity.findIdentity(identity.provider, identity.subject);
    if (linked) {
      if (linked.accountId === accountId && linked.issuer === identity.issuer) return "linked";
      throw new OidcFailure("identity_in_use", "identity-in-use");
    }
    let added: boolean;
    try {
      added = await repos.identity.linkIdentity(identityRecord(identity, accountId, clock.now()));
    } catch (error) {
      if (error instanceof UniqueViolationError)
        throw new OidcFailure("identity_in_use", "identity-in-use");
      throw error;
    }
    if (!added) throw new OidcFailure("provider_already_linked");
    const account = await repos.identity.getAccount(accountId);
    if (account) {
      await securityAlert(
        account,
        "identity-linked",
        `${providerName(identity.provider)} sign-in was linked.`,
        identity.subject,
      );
    }
    return "linked";
  }

  /** A fresh sign-in with an identity linked to the account proves it is the account holder. */
  async function reauthenticate(identity: VerifiedIdentity, tx: Transaction): Promise<OidcOutcome> {
    const { session } = await boundSession(tx);
    const linked = await repos.identity.findIdentity(identity.provider, identity.subject);
    if (!linked || linked.accountId !== session.accountId || linked.issuer !== identity.issuer) {
      throw new OidcFailure("reauth_identity_not_linked");
    }
    // `redeem` already refused a sign-in older than max_age=0 or without auth_time (fails closed).
    if (identity.authTime === null) throw new OidcFailure("auth_time_missing");
    const now = clock.now();
    const elevated = await repos.identity.elevateSession(
      session.id,
      session.accountId,
      now + ELEVATION_TTL_SEC * 1000,
      now,
    );
    if (!elevated) throw new OidcFailure("session_gone");
    return "reauthenticated";
  }

  async function elevation(auth: AuthContext): Promise<Elevation> {
    const now = clock.now();
    const [account, found, identities] = await Promise.all([
      repos.identity.getAccount(auth.session.accountId),
      repos.identity.getSession(auth.session.id, now),
      repos.identity.listIdentities(auth.session.accountId),
    ]);
    if (!account) throw new AppError("unauthenticated");
    const methods: (typeof REAUTH_METHODS)[number][] = [];
    if (account.passwordHash !== null) methods.push("password");
    for (const identity of identities) {
      const provider = providers()[identity.provider];
      if (provider?.reportsAuthTime && provider.issuer === identity.issuer)
        methods.push(identity.provider);
    }
    const until = found?.elevatedUntil ?? null;
    return { elevatedUntil: until !== null && until > now ? toIsoString(until) : null, methods };
  }

  const presentIdentity = (identity: LinkedIdentityRecord): LinkedIdentity => ({
    provider: identity.provider,
    emailAtLink: identity.emailAtLink,
    linkedAt: toIsoString(identity.createdAt),
  });

  async function requireAccount(accountId: string): Promise<IdentityAccount> {
    const account = await repos.identity.getAccount(accountId);
    if (!account) throw new AppError("not_found", { detail: "No such member" });
    return account;
  }

  return {
    jobs: jobBindings,
    scheduled: () => [identityCleanupJob.create({})],

    /**
     * The identity area's part of "Download your data" (§6.3): what the member can see of their
     * own account, sign-in methods, profiles and signed-in devices. Never a password hash, a PIN
     * or a session token.
     */
    async exportAccountData(accountId) {
      const now = clock.now();
      const [account, identities, profiles, devices] = await Promise.all([
        repos.identity.getAccount(accountId),
        repos.identity.listIdentities(accountId),
        repos.profiles.list(accountId),
        repos.sessions.listForAccount(accountId, now),
      ]);
      if (!account) return null;
      return {
        emailVerified: account.emailVerifiedAt !== null,
        emailVerifiedAt:
          account.emailVerifiedAt === null ? null : toIsoString(account.emailVerifiedAt),
        hasPassword: account.passwordHash !== null,
        linkedIdentities: identities.map((identity) => ({
          provider: identity.provider,
          emailAtLink: identity.emailAtLink,
          linkedAt: toIsoString(identity.createdAt),
          lastUsedAt: toIsoString(identity.lastUsedAt),
        })),
        profiles: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          avatarId: profile.avatarId,
          avatar: profile.avatar
            ? {
                id: profile.avatar.id,
                name: profile.avatar.name,
                imageUrl: profile.avatar.imageUrl,
              }
            : null,
          kids: profile.isKids,
          maturityCeiling: profile.maturityCeiling,
          // Whether a PIN is set, never the PIN (or its hash).
          locked: profile.pinHash !== null,
          settings: { ...profile.settings },
          createdAt: toIsoString(profile.createdAt),
        })),
        devices: devices.map((session) => ({
          id: session.id,
          label: session.deviceLabel,
          type: session.deviceType,
          signedInAt: toIsoString(session.createdAt),
          lastSeenAt: toIsoString(session.lastSeenAt),
          expiresAt: toIsoString(session.expiresAt),
        })),
      };
    },

    async eraseAccountData(accountId) {
      // Identities, tokens and sessions go with the account row (ON DELETE CASCADE); what is
      // keyed by the address instead (the outbox, a suppression) goes here.
      const account = await repos.identity.getAccount(accountId);
      if (account) await repos.identity.forgetAddress(account.email);
    },

    signInProviders() {
      return {
        items: Object.values(providers()).flatMap((provider) =>
          provider ? [{ id: provider.id, displayName: provider.displayName }] : [],
        ),
      };
    },

    async abandonedCallbackLocation(provider, transaction, error) {
      if (!(OIDC_PROVIDERS as readonly string[]).includes(provider) || !transaction) {
        return withOutcome("/", "failed", error);
      }
      const parsed = Transaction.safeParse(
        await transactions.open(transaction, `oidc:${provider}`),
      );
      return withOutcome(
        parsed.success && parsed.data.p === provider ? parsed.data.r : "/",
        "failed",
        error,
      );
    },

    refusedStartLocation(returnTo, error) {
      // The same validation as the route's query: anything else (another origin, a scheme, a
      // protocol-relative or backslashed path) falls back to the root.
      const path = ReturnPath.safeParse(returnTo);
      return withOutcome(path.success ? path.data : "/", "failed", error);
    },

    transactionCookieName(provider, secure) {
      return secure ? `__Host-webflix_oidc_${provider}` : `webflix_oidc_${provider}`;
    },

    async startOidc({ provider, intent, returnTo, auth }) {
      const issuer = providers()[provider];
      if (!issuer)
        throw new AppError("not_found", { detail: "This sign-in method is not offered" });
      let bound: Pick<Transaction, "sid" | "a"> = {};
      if (intent !== "signin") {
        if (!auth) throw new AppError("unauthenticated");
        if (intent === "link") {
          // Adding a way to sign in is account management, and a stolen session must not be
          // able to plant one that outlives a password change: a fresh proof is required.
          requireAccountHolder(auth);
          requireNotDemo(auth.session.accountId);
          if (!(await credentials.isElevated(auth)))
            throw new AppError("reauthentication_required");
        }
        bound = { sid: auth.session.id, a: auth.session.accountId };
      }
      const verifier = createPkceVerifier();
      const tx: Transaction = {
        v: 1,
        id: randomToken(),
        p: provider,
        i: intent,
        s: randomToken(),
        n: randomToken(),
        c: verifier,
        ...(intent === "reauth" ? { m: 0 } : {}),
        r: returnTo,
        ...bound,
        exp: clock.now() + OIDC_TRANSACTION_TTL_SEC * 1000,
      };
      let location: string;
      try {
        location = await issuer.authorizationUrl({
          redirectUri: callbackUri(provider),
          state: tx.s,
          nonce: tx.n,
          codeChallenge: await pkceChallenge(verifier),
          ...(tx.m !== undefined ? { maxAgeSec: tx.m } : {}),
        });
      } catch (error) {
        if (!(error instanceof IdentityProviderError)) throw error;
        // The issuer is unreachable or misconfigured (discovery naming another issuer): the
        // member is sent back with a failed outcome instead of an error page.
        logger.warn("identity.oidc_start_failed", {
          provider,
          intent,
          reason: `${error.reason}:${error.message}`,
        });
        return {
          location: withOutcome(returnTo, "failed"),
          transaction: null,
          maxAgeSec: 0,
          crossSite: false,
        };
      }
      return {
        location,
        transaction: await transactions.seal(tx, `oidc:${provider}`),
        maxAgeSec: OIDC_TRANSACTION_TTL_SEC,
        crossSite: issuer.responseMode === "form_post",
      };
    },

    async completeOidc({ provider, response, transaction, client }) {
      let returnTo = "/";
      let intent: OidcIntent = "signin";
      try {
        const tx = await openTransaction(provider, transaction);
        returnTo = tx.r;
        intent = tx.i;
        if (tx.exp <= clock.now()) throw new OidcFailure("transaction_expired");
        // The response must answer this browser's transaction: checked before anything else
        // is believed, an error response included.
        if (response.state === undefined || !sameString(response.state, tx.s)) {
          throw new OidcFailure("state_mismatch");
        }
        // The callback processes an authorisation response at most once (a replayed or
        // re-submitted response, a copied cookie).
        if (!(await repos.identity.claim(`oidc:${tx.id}`, tx.exp, clock.now()))) {
          throw new OidcFailure("transaction_replayed");
        }
        if (response.error !== undefined) {
          throw new OidcFailure(
            `issuer_error:${response.error.slice(0, 64)}`,
            response.error === "access_denied" ? "cancelled" : "failed",
          );
        }
        if (!response.code) throw new OidcFailure("code_missing");
        const issuer = providers()[provider];
        if (!issuer) throw new OidcFailure("provider_not_offered");
        const identity = await issuer.redeem({
          code: response.code,
          codeVerifier: tx.c,
          redirectUri: callbackUri(provider),
          nonce: tx.n,
          ...(tx.m !== undefined ? { maxAgeSec: tx.m } : {}),
          responseIssuer: response.iss ?? null,
        });
        if (identity.provider !== provider) throw new OidcFailure("provider_mismatch");
        let completion: OidcCompletion;
        if (tx.i === "signin") {
          const signedIn = await signInOrUp(identity, client);
          await emit(
            signedIn.outcome === "signed-up" ? "auth.signup" : "auth.signin",
            "oidc",
            "success",
            signedIn.accountId,
          );
          completion = { ...signedIn, location: withOutcome(returnTo, signedIn.outcome) };
        } else {
          const outcome =
            tx.i === "link" ? await link(identity, tx) : await reauthenticate(identity, tx);
          completion = { outcome, location: withOutcome(returnTo, outcome), session: null };
        }
        logger.info("identity.oidc_completed", { provider, intent, outcome: completion.outcome });
        return completion;
      } catch (error) {
        const outcome = error instanceof OidcFailure ? error.outcome : "failed";
        const reason =
          error instanceof OidcFailure
            ? error.message
            : error instanceof IdentityProviderError
              ? `${error.reason}:${error.message}`
              : "unexpected";
        const fields = { provider, intent, outcome, reason };
        if (error instanceof OidcFailure || error instanceof IdentityProviderError) {
          logger.warn("identity.oidc_failed", fields);
        } else {
          logger.error("identity.oidc_failed", { ...fields, error: serializeError(error) });
        }
        if (intent === "signin") await emit("auth.signin", "oidc", "failure", null);
        return { outcome, location: withOutcome(returnTo, outcome), session: null };
      }
    },

    async listIdentities(auth) {
      const [account, identities] = await Promise.all([
        repos.identity.getAccount(auth.session.accountId),
        repos.identity.listIdentities(auth.session.accountId),
      ]);
      if (!account) throw new AppError("unauthenticated");
      return { items: identities.map(presentIdentity), hasPassword: account.passwordHash !== null };
    },

    async unlinkIdentity(auth, provider) {
      requireNotDemo(auth.session.accountId);
      if (!(await credentials.isElevated(auth))) throw new AppError("reauthentication_required");
      const outcome = await repos.identity.unlinkIdentity(
        auth.session.accountId,
        provider,
        clock.now(),
      );
      if (outcome === "not_found")
        throw new AppError("not_found", { detail: "No such sign-in method" });
      if (outcome === "last") throw new AppError("identity_last_sign_in_method");
      const account = await repos.identity.getAccount(auth.session.accountId);
      if (account) {
        await securityAlert(
          account,
          "identity-unlinked",
          `${providerName(provider)} sign-in was removed.`,
          ids.next(),
        );
      }
    },

    getElevation: elevation,

    async elevate(auth, password) {
      // The route is request-scoped: the guard already charged this attempt to `profile-pin`.
      await credentials.provePassword(auth, password, async () => {});
      const now = clock.now();
      await repos.identity.elevateSession(
        auth.session.id,
        auth.session.accountId,
        now + ELEVATION_TTL_SEC * 1000,
        now,
      );
      return elevation(auth);
    },

    async requestEmailVerification(auth, charge) {
      const account = await repos.identity.getAccount(auth.session.accountId);
      if (!account) throw new AppError("unauthenticated");
      if (account.emailVerifiedAt !== null || isDemoAccount(account.id)) return;
      await charge(account.email);
      await jobs.publish(verificationEmailJob.create({ accountId: account.id }));
    },

    async confirmEmailVerification(token) {
      const accountId = await repos.identity.consumeVerificationToken(
        await hashToken(token),
        clock.now(),
      );
      if (accountId === null) throw new AppError("verification_token_invalid");
      logger.info("identity.email_verified", { accountId });
    },

    async requestPasswordReset(email, charge) {
      // Exactly the same work whether or not the address has an account: charge the address,
      // queue the job, answer 204. The lookup happens in the job.
      await charge(email);
      await jobs.publish(passwordResetEmailJob.create({ email }));
    },

    async confirmPasswordReset(token, newPassword) {
      const tokenHash = await hashToken(token);
      const live = await repos.identity.findLiveToken(tokenHash, "reset_password", clock.now());
      if (!live) throw new AppError("verification_token_invalid");
      requireNotDemo(live.accountId);
      const passwordHash = await passwords.hash(newPassword);
      const reset = await repos.identity.completePasswordReset({
        tokenHash,
        passwordHash,
        now: clock.now(),
      });
      if (!reset) throw new AppError("verification_token_invalid");
      await streamGate.releaseAll(reset.accountId);
      logger.info("identity.password_reset", {
        accountId: reset.accountId,
        unlinked: reset.unlinked.length,
      });
      const detail =
        reset.unlinked.length > 0
          ? `Sign-in methods linked under another address were removed: ${reset.unlinked.map(providerName).join(", ")}.`
          : null;
      await securityAlert(
        { id: reset.accountId, email: reset.email },
        "password-reset",
        detail,
        tokenHash.slice(0, 16),
      );
    },

    async receiveEmailWebhook(provider, headers, body) {
      const http = config.identity.emailHttp;
      if (!http || http.provider !== provider || http.webhookSecret === null) {
        throw new AppError("not_found", { detail: "No such email provider" });
      }
      let events: Awaited<ReturnType<typeof parseResendWebhook>>;
      try {
        events = await parseResendWebhook({
          secret: http.webhookSecret,
          headers,
          body,
          nowSec: Math.floor(clock.now() / 1000),
        });
      } catch (error) {
        if (error instanceof EmailWebhookError) {
          logger.warn("identity.email_webhook_refused", { provider, reason: error.message });
          throw new AppError("webhook_signature_invalid");
        }
        throw error;
      }
      for (const event of events) {
        await repos.identity.suppress({
          address: event.address,
          reason: event.reason,
          source: provider,
          createdAt: clock.now(),
        });
      }
      logger.info("identity.email_suppressions", { provider, count: events.length });
      return { received: true, duplicate: false };
    },

    async mailbox({ to, since }) {
      const sender = deps.email;
      if (config.environment === "production" || !isLocalMailbox(sender)) {
        throw new AppError("not_found", { detail: "No local mailbox in this deployment" });
      }
      const from = since === undefined ? 0 : Date.parse(since);
      const delivered = await sender.listDelivered(to, from);
      return {
        items: delivered.slice(-MAILBOX_LIMIT).map((message) => ({
          id: message.messageId,
          to: message.to,
          from: message.from,
          subject: message.subject,
          template: message.template,
          text: message.text,
          html: message.html,
          links: emailLinks(message),
          createdAt: toIsoString(message.sentAt),
        })),
      };
    },

    async sendEmail(request) {
      await jobs.publish(
        sendEmailJob.create({
          to: request.to,
          template: request.template,
          data: request.data as Record<string, unknown>,
          key: request.idempotencyKey,
        }),
      );
    },

    async searchMembers({ q, cursor, limit }) {
      const size = Math.min(Math.max(limit ?? 25, 1), 100);
      const after = cursor === undefined ? null : decodeCursor(cursor, SearchCursor);
      if (cursor !== undefined && after === null) {
        throw new AppError("validation_failed", {
          issues: [
            { location: "query", path: "cursor", message: "Invalid cursor", code: "custom" },
          ],
        });
      }
      const rows = await repos.identity.searchAccounts(
        q,
        after ? { email: after.e, id: after.i } : null,
        size + 1,
      );
      const page = rows.slice(0, size);
      const last = page.at(-1);
      return {
        items: page.map((account) => ({
          accountId: account.id,
          email: account.email,
          createdAt: toIsoString(account.createdAt),
          isDemo: isDemoAccount(account.id),
        })),
        nextCursor: rows.length > size && last ? encodeCursor({ e: last.email, i: last.id }) : null,
      };
    },

    async getMemberIdentity(accountId) {
      const account = await requireAccount(accountId);
      const [identities, profiles, activeDevices] = await Promise.all([
        repos.identity.listIdentities(accountId),
        repos.profiles.list(accountId),
        repos.identity.countSessions(accountId, clock.now()),
      ]);
      return {
        account: {
          id: account.id,
          email: account.email,
          emailVerified: account.emailVerifiedAt !== null,
          hasPassword: account.passwordHash !== null,
          createdAt: toIsoString(account.createdAt),
          isDemo: isDemoAccount(account.id),
        },
        identities: identities.map(presentIdentity),
        profiles: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          isKids: profile.isKids,
          maturityCeiling: profile.maturityCeiling,
          locked: profile.pinHash !== null,
        })),
        activeDevices,
      };
    },

    async signOutMemberEverywhere(accountId) {
      requireNotDemo(accountId);
      await requireAccount(accountId);
      const sessionsEnded = await repos.identity.countSessions(accountId, clock.now());
      await repos.sessions.deleteAllForAccount(accountId);
      await streamGate.releaseAll(accountId);
      return { sessionsEnded };
    },

    async sendMemberPasswordReset(accountId) {
      requireNotDemo(accountId);
      const account = await requireAccount(accountId);
      await jobs.publish(passwordResetEmailJob.create({ email: account.email }));
      return { email: account.email };
    },

    async removeMemberProfilePin(accountId, profileId) {
      requireNotDemo(accountId);
      const profile = await repos.profiles.get(accountId, profileId);
      if (!profile) throw new AppError("not_found", { detail: "No such profile" });
      if (profile.pinHash === null) return { hadPin: false };
      const updated = await repos.profiles.update(accountId, profileId, {
        pinHash: null,
        updatedAt: clock.now(),
      });
      if (!updated) throw new AppError("not_found", { detail: "No such profile" });
      return { hadPin: true };
    },
  };
}
