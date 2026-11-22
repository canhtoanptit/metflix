import type { OidcProvider } from "@webflix/contracts";
import type {
  AccountTokenRecord,
  EmailSuppression,
  IdentityAccount,
  IdentityRemoval,
  IdentityRepository,
  LinkedIdentityRecord,
  OutboxEntry,
} from "../../areas/identity/repository.ts";
import { UniqueViolationError } from "../../repositories/ports.ts";
import type { AccountRecord } from "../../repositories/records.ts";
import type { MemoryStore } from "../repositories.ts";

const copy = <T>(value: T): T => structuredClone(value);

/** The identity area's own state, kept beside the milestone 1 store it extends. */
interface IdentityState {
  emailVerifiedAt: Map<string, number>;
  elevatedUntil: Map<string, number>;
  identities: Map<string, LinkedIdentityRecord>;
  tokens: Map<string, AccountTokenRecord>;
  outbox: Map<string, OutboxEntry>;
  suppressions: Map<string, EmailSuppression>;
  claims: Map<string, number>;
  removals: Map<string, IdentityRemoval>;
}

const states = new WeakMap<object, IdentityState>();

function stateOf(owner: object): IdentityState {
  let state = states.get(owner);
  if (!state) {
    state = {
      emailVerifiedAt: new Map(),
      elevatedUntil: new Map(),
      identities: new Map(),
      tokens: new Map(),
      outbox: new Map(),
      suppressions: new Map(),
      claims: new Map(),
      removals: new Map(),
    };
    states.set(owner, state);
  }
  return state;
}

const identityKey = (provider: string, subject: string) => `${provider}\u0000${subject}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * In-memory `IdentityRepository` over the milestone 1 memory store (accounts and sessions live
 * there; this area's columns and tables live beside it). Every method completes without awaiting
 * in the middle, so each is atomic on the single JS thread, like a batch. Without a store (unit
 * tests of this repository alone) it keeps a private one.
 */
export function createMemoryIdentityRepository(store?: MemoryStore): IdentityRepository {
  const accounts: Map<string, AccountRecord> = store?.accounts ?? new Map();
  const sessions = store?.sessions ?? new Map();
  const s = stateOf(store ?? accounts);
  const tick = () => {
    if (store) store.queries += 1;
  };

  const present = (account: AccountRecord): IdentityAccount => ({
    id: account.id,
    email: account.email,
    // The empty string is how storage says "no password" (accounts.password_hash is NOT NULL).
    passwordHash: account.passwordHash === "" ? null : account.passwordHash,
    emailVerifiedAt: s.emailVerifiedAt.get(account.id) ?? null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  });
  const emailTaken = (email: string, exceptId?: string) =>
    [...accounts.values()].some((account) => account.email === email && account.id !== exceptId);
  /** An identity whose account was deleted is gone (ON DELETE CASCADE in SQL). */
  const liveIdentity = (identity: LinkedIdentityRecord | undefined) =>
    identity && accounts.has(identity.accountId) ? identity : undefined;
  const liveToken = (tokenHash: string, purpose: string, now: number) => {
    const token = s.tokens.get(tokenHash);
    if (!token || token.purpose !== purpose || token.usedAt !== null || token.expiresAt <= now) {
      return undefined;
    }
    const account = accounts.get(token.accountId);
    return account && account.email === token.email ? token : undefined;
  };
  const identitiesOf = (accountId: string) =>
    [...s.identities.values()]
      .filter((identity) => identity.accountId === accountId)
      .sort((a, b) => a.createdAt - b.createdAt || cmp(a.provider, b.provider));

  return {
    async getAccount(accountId) {
      tick();
      const account = accounts.get(accountId);
      return account ? present(account) : null;
    },

    async getAccountWithSubscription(accountId) {
      tick();
      const account = accounts.get(accountId);
      if (!account) return null;
      const subscription = store?.subscriptions.get(accountId);
      return { account: present(account), subscription: subscription ? copy(subscription) : null };
    },

    async loadBootstrap(accountId) {
      tick();
      const account = accounts.get(accountId);
      if (!account || !store)
        return account ? { account: present(account), subscription: null, profiles: [] } : null;
      const subscription = store.subscriptions.get(accountId);
      const profiles = [...store.profiles.values()]
        .filter((profile) => profile.accountId === accountId)
        .sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id))
        .map((profile) => store.withAvatar(profile));
      return {
        account: present(account),
        subscription: subscription ? copy(subscription) : null,
        profiles,
      };
    },

    async findAccountByEmail(email) {
      tick();
      const account = [...accounts.values()].find((candidate) => candidate.email === email);
      return account ? present(account) : null;
    },

    async createAccount({ account, session, identity }) {
      tick();
      if (emailTaken(account.email) || accounts.has(account.id)) {
        throw new UniqueViolationError("email");
      }
      if (identity && s.identities.has(identityKey(identity.provider, identity.subject))) {
        throw new UniqueViolationError("identity");
      }
      accounts.set(account.id, {
        id: account.id,
        email: account.email,
        passwordHash: account.passwordHash ?? "",
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      });
      if (account.emailVerifiedAt !== null) {
        s.emailVerifiedAt.set(account.id, account.emailVerifiedAt);
      }
      sessions.set(session.id, copy(session));
      if (identity)
        s.identities.set(identityKey(identity.provider, identity.subject), copy(identity));
    },

    async changeEmail(accountId, email, now) {
      tick();
      if (emailTaken(email, accountId)) throw new UniqueViolationError("email");
      const account = accounts.get(accountId);
      if (!account) return;
      Object.assign(account, { email, updatedAt: now });
      s.emailVerifiedAt.delete(accountId);
    },

    async markEmailVerified(accountId, email, now) {
      tick();
      const account = accounts.get(accountId);
      if (!account || account.email !== email) return false;
      if (!s.emailVerifiedAt.has(accountId)) s.emailVerifiedAt.set(accountId, now);
      return true;
    },

    async findIdentity(provider, subject) {
      tick();
      const identity = liveIdentity(s.identities.get(identityKey(provider, subject)));
      return identity ? copy(identity) : null;
    },

    async listIdentities(accountId) {
      tick();
      return identitiesOf(accountId).map(copy);
    },

    async linkIdentity(identity) {
      tick();
      const key = identityKey(identity.provider, identity.subject);
      const existing = s.identities.get(key);
      if (existing && accounts.has(existing.accountId)) throw new UniqueViolationError("identity");
      if (identitiesOf(identity.accountId).some((other) => other.provider === identity.provider)) {
        return false;
      }
      s.identities.set(key, copy(identity));
      return true;
    },

    async touchIdentity(provider, subject, now) {
      tick();
      const identity = s.identities.get(identityKey(provider, subject));
      if (identity) identity.lastUsedAt = now;
    },

    async unlinkIdentity(accountId, provider: OidcProvider, now) {
      tick();
      const owned = identitiesOf(accountId);
      const target = owned.find((identity) => identity.provider === provider);
      if (!target) return "not_found";
      const account = accounts.get(accountId);
      const hasPassword = account !== undefined && account.passwordHash !== "";
      if (!hasPassword && owned.length <= 1) return "last";
      const key = identityKey(target.provider, target.subject);
      s.removals.set(key, { accountId, reason: "unlinked", removedAt: now });
      s.identities.delete(key);
      return "unlinked";
    },

    async findRemoval(provider, subject) {
      tick();
      const removal = s.removals.get(identityKey(provider, subject));
      // Gone with its account (ON DELETE CASCADE in SQL).
      return removal && accounts.has(removal.accountId) ? copy(removal) : null;
    },

    async getSession(sessionId, now) {
      tick();
      const session = sessions.get(sessionId);
      if (!session || session.expiresAt <= now) return null;
      return { session: copy(session), elevatedUntil: s.elevatedUntil.get(sessionId) ?? null };
    },

    async elevateSession(sessionId, accountId, until, now) {
      tick();
      const session = sessions.get(sessionId);
      if (!session || session.accountId !== accountId || session.expiresAt <= now) return false;
      s.elevatedUntil.set(sessionId, until);
      return true;
    },

    async createToken(token) {
      tick();
      s.tokens.set(token.tokenHash, copy(token));
    },

    async findLiveToken(tokenHash, purpose, now) {
      tick();
      const token = liveToken(tokenHash, purpose, now);
      return token ? copy(token) : null;
    },

    async consumeVerificationToken(tokenHash, now) {
      tick();
      const token = liveToken(tokenHash, "verify_email", now);
      if (!token) return null;
      token.usedAt = now;
      if (!s.emailVerifiedAt.has(token.accountId)) s.emailVerifiedAt.set(token.accountId, now);
      return token.accountId;
    },

    async completePasswordReset({ tokenHash, passwordHash, now }) {
      tick();
      const token = liveToken(tokenHash, "reset_password", now);
      const account = token ? accounts.get(token.accountId) : undefined;
      if (!token || !account) return null;
      Object.assign(account, { passwordHash, updatedAt: now });
      if (!s.emailVerifiedAt.has(account.id)) s.emailVerifiedAt.set(account.id, now);
      for (const [id, session] of sessions) {
        if (session.accountId === account.id) sessions.delete(id);
      }
      const unlinked: OidcProvider[] = [];
      for (const identity of identitiesOf(account.id)) {
        if (identity.emailAtLink !== account.email) {
          const key = identityKey(identity.provider, identity.subject);
          s.removals.set(key, { accountId: account.id, reason: "password_reset", removedAt: now });
          s.identities.delete(key);
          unlinked.push(identity.provider);
        }
      }
      for (const other of s.tokens.values()) {
        if (
          other.accountId === account.id &&
          other.purpose === "reset_password" &&
          other.usedAt === null
        ) {
          other.usedAt = now;
        }
      }
      return { accountId: account.id, email: account.email, unlinked };
    },

    async recordEmail(entry) {
      tick();
      const existing = [...s.outbox.values()].find(
        (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
      );
      if (existing) return { created: false, id: existing.id };
      s.outbox.set(entry.id, copy(entry));
      return { created: true, id: entry.id };
    },

    async listMailbox(to, since, limit) {
      tick();
      const wanted = to.toLowerCase();
      return [...s.outbox.values()]
        .filter(
          (entry) =>
            entry.to.toLowerCase() === wanted &&
            entry.createdAt >= since &&
            entry.html !== null &&
            entry.text !== null,
        )
        .sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id))
        .slice(0, limit)
        .map(copy);
    },

    async isSuppressed(address) {
      tick();
      return s.suppressions.has(address.toLowerCase());
    },

    async forgetAddress(address) {
      tick();
      const wanted = address.toLowerCase();
      for (const [id, entry] of s.outbox)
        if (entry.to.toLowerCase() === wanted) s.outbox.delete(id);
      s.suppressions.delete(wanted);
    },

    async suppress(entry) {
      tick();
      const address = entry.address.toLowerCase();
      if (!s.suppressions.has(address)) s.suppressions.set(address, { ...entry, address });
    },

    async claim(key, expiresAt, now) {
      tick();
      const existing = s.claims.get(key);
      if (existing !== undefined && existing > now) return false;
      s.claims.set(key, expiresAt);
      return true;
    },

    async hasClaim(key, now) {
      tick();
      const expiresAt = s.claims.get(key);
      return expiresAt !== undefined && expiresAt > now;
    },

    async deleteExpired(now, limit) {
      tick();
      let deleted = 0;
      for (const [key, expiresAt] of s.claims) {
        if (deleted >= limit) return deleted;
        if (expiresAt <= now) {
          s.claims.delete(key);
          deleted += 1;
        }
      }
      for (const [hash, token] of s.tokens) {
        if (deleted >= limit) return deleted;
        if (token.expiresAt <= now || token.usedAt !== null) {
          s.tokens.delete(hash);
          deleted += 1;
        }
      }
      return deleted;
    },

    async searchAccounts(query, after, limit) {
      tick();
      const wanted = query.trim().toLowerCase();
      return (
        [...accounts.values()]
          .filter((account) => account.email.startsWith(wanted) || account.id === query.trim())
          // Code-unit order, as the SQL repositories compare (binary collation).
          .sort((a, b) => cmp(a.email, b.email) || cmp(a.id, b.id))
          .filter(
            (account) =>
              after === null ||
              account.email > after.email ||
              (account.email === after.email && account.id > after.id),
          )
          .slice(0, limit)
          .map(present)
      );
    },

    async countSessions(accountId, now) {
      tick();
      return [...sessions.values()].filter(
        (session) => session.accountId === accountId && session.expiresAt > now,
      ).length;
    },
  };
}
