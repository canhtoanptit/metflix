import type { OidcProvider } from "@webflix/contracts";
import type {
  ProfileRecord,
  SessionRecord,
  SubscriptionRecord,
} from "../../repositories/records.ts";

/**
 * Repository port of the identity area: `account_identities`, `account_tokens`, `email_outbox`,
 * `email_suppressions`, `identity_claims`, and the milestone 2 columns of `accounts`
 * (`email_verified_at`) and `sessions` (`elevated_until`), migrations under
 * `packages/db/src/migrations/identity/`.
 *
 * Implemented in memory by `packages/core/src/memory/areas/identity.ts` and on every dialect by
 * `packages/db/src/repositories/areas/identity.ts`; both pass `describeIdentityRepositoryContract`
 * (`packages/core/src/testing/areas/identity.contract.ts`). The D1 rules hold: one method per
 * atomic write (one batch, conditions in SQL), at most 100 bound parameters per statement.
 */
export interface IdentityRepository {
  // --- Accounts (read without the membership, which is billing's) ----------------------------

  getAccount(accountId: string): Promise<IdentityAccount | null>;
  /**
   * The account and its milestone 1 subscription row, null when it has none (an account created
   * before payment, §5.1), in one statement. Milestone 1's `repos.accounts.get` answers null for
   * such an account; this read does not. Null when the account does not exist.
   */
  getAccountWithSubscription(
    accountId: string,
  ): Promise<{ account: IdentityAccount; subscription: SubscriptionRecord | null } | null>;
  /**
   * The session bootstrap's reads in one round trip: the account (with the identity columns),
   * its milestone 1 subscription row (null without one) and its profiles, oldest first. Null
   * when the account does not exist.
   */
  loadBootstrap(accountId: string): Promise<{
    account: IdentityAccount;
    subscription: SubscriptionRecord | null;
    profiles: ProfileRecord[];
  } | null>;
  /** `email` is normalised (trimmed, lowercased) by the caller. */
  findAccountByEmail(email: string): Promise<IdentityAccount | null>;
  /**
   * Sign-up without a membership (§5.1): the account, its first session and, for a federated
   * sign-up, the issuer identity, atomically. Throws `UniqueViolationError("email")` or
   * `UniqueViolationError("identity")`.
   */
  createAccount(input: {
    account: IdentityAccount;
    session: SessionRecord;
    identity: LinkedIdentityRecord | null;
  }): Promise<void>;
  /**
   * The address changes and is no longer verified, in one statement. Outstanding email tokens for
   * the old address stop working (they are bound to the address they were sent to). Throws
   * `UniqueViolationError("email")`.
   */
  changeEmail(accountId: string, email: string, now: number): Promise<void>;
  /**
   * Marks the address verified when the account still has exactly this address (an issuer that
   * verified it, for an account it signs in to). False otherwise.
   */
  markEmailVerified(accountId: string, email: string, now: number): Promise<boolean>;

  // --- Linked identities (§4.1) --------------------------------------------------------------

  /** Identities are keyed by (provider, subject) only, never by email. */
  findIdentity(provider: OidcProvider, subject: string): Promise<LinkedIdentityRecord | null>;
  /** Oldest first. */
  listIdentities(accountId: string): Promise<LinkedIdentityRecord[]>;
  /**
   * Links an identity, unless the account already has one for this provider (false). Throws
   * `UniqueViolationError("identity")` when (provider, subject) belongs to any account.
   */
  linkIdentity(identity: LinkedIdentityRecord): Promise<boolean>;
  touchIdentity(provider: OidcProvider, subject: string, now: number): Promise<void>;
  /**
   * Unlinks the account's identity for `provider`, unless it is the account's last way to sign
   * in (no password and no other identity): decided in the same statement. An unlinked identity
   * is recorded as removed (`findRemoval`) in the same batch.
   */
  unlinkIdentity(
    accountId: string,
    provider: OidcProvider,
    now: number,
  ): Promise<"unlinked" | "not_found" | "last">;
  /**
   * The latest removal of an identity from an account (the member unlinked it, or a password
   * reset dropped it): such an identity is never linked again automatically (§4.1), only
   * deliberately. Null when it was never removed (or its account is gone).
   */
  findRemoval(provider: OidcProvider, subject: string): Promise<IdentityRemoval | null>;

  // --- Sessions: the account-holder proof (§4.2) ------------------------------------------------

  /** A live session by id, with its proof (`elevated_until`), or null. */
  getSession(sessionId: string, now: number): Promise<IdentitySession | null>;
  /** Sets `elevated_until` on a live session of the account; false when there is none. */
  elevateSession(
    sessionId: string,
    accountId: string,
    until: number,
    now: number,
  ): Promise<boolean>;

  // --- Single-use email tokens (§4.3) ---------------------------------------------------------

  /** Stores a token (only its hash). */
  createToken(token: AccountTokenRecord): Promise<void>;
  /**
   * The token's record while it is unused, unexpired and still bound to the account's current
   * address; null otherwise. Reads only: nothing is consumed.
   */
  findLiveToken(
    tokenHash: string,
    purpose: AccountTokenPurpose,
    now: number,
  ): Promise<AccountTokenRecord | null>;
  /**
   * Email verification, atomically: consumes the live `verify_email` token and marks the address
   * verified. The account it verified, or null when the token is unknown, used, expired or no
   * longer for the account's address.
   */
  consumeVerificationToken(tokenHash: string, now: number): Promise<string | null>;
  /**
   * Password reset, atomically: consumes the live `reset_password` token and every other open
   * reset token of the account, sets the new password hash, marks the address verified (the
   * link proved it), signs out every device, and unlinks the issuer identities linked under an
   * address other than the account's, recording them as removed (a takeover planted before the
   * owner proved the address does not survive, nor come back by itself). The account, or null when the token is unknown, used, expired or no longer
   * for the account's address (then nothing changes).
   */
  completePasswordReset(input: {
    tokenHash: string;
    passwordHash: string;
    now: number;
  }): Promise<{ accountId: string; email: string; unlinked: OidcProvider[] } | null>;

  // --- Email: outbox and suppressions (§8.2) ---------------------------------------------------

  /**
   * Records a message under its idempotency key unless one is already recorded: the D1 outbox of
   * local Cloudflare and the mailbox read-back. The existing row's id when it was recorded before.
   */
  recordEmail(entry: OutboxEntry): Promise<{ created: boolean; id: string }>;
  /** Delivered messages kept with their bodies, for `to`, oldest first, at most `limit`. */
  listMailbox(to: string, since: number, limit: number): Promise<OutboxEntry[]>;
  isSuppressed(address: string): Promise<boolean>;
  /** Account deletion (§6.3): the outbox's messages to an address and its suppression go. */
  forgetAddress(address: string): Promise<void>;
  /** Idempotent: an address already suppressed keeps its first reason. */
  suppress(entry: EmailSuppression): Promise<void>;

  // --- Single use without a server session --------------------------------------------------

  /**
   * Claims `key` until `expiresAt`: true for the first caller, false while a live claim exists
   * (an OpenID callback processed twice, a replayed authorisation response).
   */
  claim(key: string, expiresAt: number, now: number): Promise<boolean>;
  /** True while a live claim for `key` exists (read-after-write: the development issuer's store). */
  hasClaim(key: string, now: number): Promise<boolean>;
  /** Deletes expired claims and spent or expired tokens, up to `limit`; how many went. */
  deleteExpired(now: number, limit: number): Promise<number>;

  // --- Staff support (the admin area's member routes) ----------------------------------------

  /** Accounts whose email starts with `query` (or whose id equals it), by email then id. */
  searchAccounts(
    query: string,
    after: { email: string; id: string } | null,
    limit: number,
  ): Promise<IdentityAccount[]>;
  /** How many live sessions (signed-in devices) the account has. */
  countSessions(accountId: string, now: number): Promise<number>;
}

/** An account as the identity area reads it (the membership is billing's). */
export interface IdentityAccount {
  id: string;
  /** Normalised: trimmed and lowercased. */
  email: string;
  /**
   * PHC hash, or null for an account created through an issuer that never set a password.
   * Stored as the empty string (`accounts.password_hash` is NOT NULL, FOUNDATION.md D-M2-5);
   * repositories map it to null and back, so no code ever compares a password against it.
   */
  passwordHash: string | null;
  emailVerifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface LinkedIdentityRecord {
  provider: OidcProvider;
  /** Opaque, up to 255 characters. */
  subject: string;
  accountId: string;
  /** The issuer that asserted it: an identity is never trusted for another issuer. */
  issuer: string;
  /** The address the issuer asserted when it was linked. */
  emailAtLink: string | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface IdentityRemoval {
  accountId: string;
  reason: "unlinked" | "password_reset";
  removedAt: number;
}

export interface IdentitySession {
  session: SessionRecord;
  elevatedUntil: number | null;
}

export const ACCOUNT_TOKEN_PURPOSES = ["verify_email", "reset_password"] as const;
export type AccountTokenPurpose = (typeof ACCOUNT_TOKEN_PURPOSES)[number];

export interface AccountTokenRecord {
  /** SHA-256 (hex) of the token; the token itself is never stored. */
  tokenHash: string;
  accountId: string;
  purpose: AccountTokenPurpose;
  /** The address it was sent to: it works only while the account still has it. */
  email: string;
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
}

export interface OutboxEntry {
  id: string;
  idempotencyKey: string;
  to: string;
  from: string;
  template: string;
  subject: string;
  /** Kept only by local mailboxes (never in production): links in them are live credentials. */
  html: string | null;
  text: string | null;
  status: "sent";
  providerMessageId: string | null;
  createdAt: number;
  sentAt: number | null;
}

export interface EmailSuppression {
  address: string;
  reason: "bounce" | "complaint" | "manual";
  /** Who reported it (`resend`, `staff`...). */
  source: string;
  createdAt: number;
}
