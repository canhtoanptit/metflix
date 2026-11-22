import type { OidcProvider } from "@webflix/contracts";
import {
  type AccountTokenRecord,
  type IdentityAccount,
  type IdentityRepository,
  type LinkedIdentityRecord,
  type OutboxEntry,
  UniqueViolationError,
} from "@webflix/core";
import { type RawBuilder, sql } from "kysely";
import { type Database, isUniqueViolation } from "../../database.ts";
import type { AccountsTable } from "../../schema.ts";
import type {
  AccountIdentitiesTable,
  AccountTokensTable,
  EmailOutboxTable,
} from "../../tables/identity.ts";
import {
  excluded,
  fromSession,
  PROFILE_JOIN_COLUMNS,
  type ProfileJoinRow,
  toProfile,
  toSession,
  toSubscription,
} from "../mapping.ts";

/** How storage says "no password" (`accounts.password_hash` is NOT NULL, FOUNDATION.md D-M2-5). */
const NO_PASSWORD = "";

function toAccount(
  row: Pick<
    AccountsTable,
    "id" | "email" | "password_hash" | "email_verified_at" | "created_at" | "updated_at"
  >,
): IdentityAccount {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash === NO_PASSWORD ? null : row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIdentity(row: AccountIdentitiesTable): LinkedIdentityRecord {
  return {
    provider: row.provider as OidcProvider,
    subject: row.subject,
    accountId: row.account_id,
    issuer: row.issuer,
    emailAtLink: row.email_at_link,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function toToken(row: AccountTokensTable): AccountTokenRecord {
  return {
    tokenHash: row.token_hash,
    accountId: row.account_id,
    purpose: row.purpose as AccountTokenRecord["purpose"],
    email: row.email,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

function toOutbox(row: EmailOutboxTable): OutboxEntry {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    to: row.to_address,
    from: row.from_address,
    template: row.template,
    subject: row.subject,
    html: row.html_body,
    text: row.text_body,
    status: "sent",
    providerMessageId: row.provider_message_id,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

const ACCOUNT_COLUMNS = [
  "id",
  "email",
  "password_hash",
  "email_verified_at",
  "created_at",
  "updated_at",
] as const;

/**
 * The identity area's repository on every dialect (SQLite, PostgreSQL, D1), over its tables
 * (`tables/identity.ts`) and the milestone 1 `accounts` and `sessions`. Every atomic write is one
 * statement or one batch whose conditions live in SQL (D1 has no interactive transactions);
 * passes `describeIdentityRepositoryContract` here and in workerd.
 */
export function createIdentityRepository(database: Database): IdentityRepository {
  const { db, dialect } = database;

  /** Binary (code-unit) order on every dialect: Postgres' default collation is locale-aware. */
  const binary = (column: string): RawBuilder<string> =>
    dialect === "postgres"
      ? sql<string>`${sql.ref(column)} collate "C"`
      : sql<string>`${sql.ref(column)}`;

  /** The account and its milestone 1 subscription row, if any (a left join: one statement). */
  const accountWithSubscription = (accountId: string) =>
    db
      .selectFrom("accounts as a")
      .leftJoin("subscriptions as s", "s.account_id", "a.id")
      .select([
        "a.id",
        "a.email",
        "a.password_hash",
        "a.email_verified_at",
        "a.created_at",
        "a.updated_at",
        "s.account_id as s_account_id",
        "s.plan_id as s_plan_id",
        "s.started_at as s_started_at",
        "s.current_period_end as s_current_period_end",
        "s.canceled_at as s_canceled_at",
        "s.card_brand as s_card_brand",
        "s.card_last4 as s_card_last4",
        "s.card_exp_month as s_card_exp_month",
        "s.card_exp_year as s_card_exp_year",
        "s.updated_at as s_updated_at",
      ])
      .where("a.id", "=", accountId);

  type AccountWithSubscriptionRow = Awaited<
    ReturnType<ReturnType<typeof accountWithSubscription>["executeTakeFirstOrThrow"]>
  >;

  const toAccountWithSubscription = (row: AccountWithSubscriptionRow) => ({
    account: toAccount(row),
    subscription:
      row.s_account_id === null || row.s_plan_id === null
        ? null
        : toSubscription({
            account_id: row.s_account_id,
            plan_id: row.s_plan_id,
            started_at: Number(row.s_started_at),
            current_period_end: Number(row.s_current_period_end),
            canceled_at: row.s_canceled_at === null ? null : Number(row.s_canceled_at),
            card_brand: row.s_card_brand,
            card_last4: row.s_card_last4,
            card_exp_month: row.s_card_exp_month === null ? null : Number(row.s_card_exp_month),
            card_exp_year: row.s_card_exp_year === null ? null : Number(row.s_card_exp_year),
            updated_at: Number(row.s_updated_at),
          }),
  });

  /** Account ids holding a live token of `purpose` for their current address (a subquery). */
  const liveTokenAccount = (tokenHash: string, purpose: string, now: number) =>
    db
      .selectFrom("account_tokens as t")
      .innerJoin("accounts as a", (join) =>
        join.onRef("a.id", "=", "t.account_id").onRef("a.email", "=", "t.email"),
      )
      .select("t.account_id")
      .where("t.token_hash", "=", tokenHash)
      .where("t.purpose", "=", purpose)
      .where("t.used_at", "is", null)
      .where("t.expires_at", ">", now);

  /** Consumes exactly this token when it is still live (the batch's success marker). */
  const consumeToken = (tokenHash: string, purpose: string, now: number) =>
    db
      .updateTable("account_tokens")
      .set({ used_at: now })
      .where("token_hash", "=", tokenHash)
      .where("purpose", "=", purpose)
      .where("used_at", "is", null)
      .where("expires_at", ">", now)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("accounts as a")
            .select("a.id")
            .whereRef("a.id", "=", "account_tokens.account_id")
            .whereRef("a.email", "=", "account_tokens.email"),
        ),
      );

  /**
   * Records as removed (never auto-linked again, §4.1) the identities `select` picks, keeping the
   * latest removal per identity. Runs in the same batch as the delete, before it.
   */
  const recordRemovals = (
    reason: "unlinked" | "password_reset",
    now: number,
    // biome-ignore lint/suspicious/noExplicitAny: a WHERE over account_identities, built by the caller.
    where: (query: any) => any,
  ) =>
    db
      .insertInto("identity_removals")
      .columns(["provider", "subject", "account_id", "reason", "removed_at"])
      .expression(
        where(
          db
            .selectFrom("account_identities")
            .select((eb) => [
              "account_identities.provider",
              "account_identities.subject",
              "account_identities.account_id",
              eb.val(reason).as("reason"),
              eb.val(now).as("removed_at"),
            ]),
        ),
      )
      .onConflict((oc) =>
        oc.columns(["provider", "subject"]).doUpdateSet((eb) => ({
          account_id: excluded(eb, "account_id"),
          reason: excluded(eb, "reason"),
          removed_at: excluded(eb, "removed_at"),
        })),
      );

  return {
    async getAccount(accountId) {
      const row = await db
        .selectFrom("accounts")
        .select(ACCOUNT_COLUMNS)
        .where("id", "=", accountId)
        .executeTakeFirst();
      return row ? toAccount(row) : null;
    },

    async getAccountWithSubscription(accountId) {
      const row = await accountWithSubscription(accountId).executeTakeFirst();
      return row ? toAccountWithSubscription(row) : null;
    },

    async loadBootstrap(accountId) {
      // One round trip (a D1 batch): the account with its subscription row, and its profiles.
      const [accountRows, profileRows] = await database.batch([
        accountWithSubscription(accountId),
        db
          .selectFrom("profiles as p")
          .leftJoin("avatars as av", "av.id", "p.avatar_id")
          .select(PROFILE_JOIN_COLUMNS)
          .where("p.account_id", "=", accountId)
          .orderBy("p.created_at")
          .orderBy("p.id"),
      ]);
      const row = accountRows.rows[0];
      if (!row) return null;
      return {
        ...toAccountWithSubscription(row),
        profiles: profileRows.rows.map((profile) => toProfile(profile as ProfileJoinRow)),
      };
    },

    async findAccountByEmail(email) {
      const row = await db
        .selectFrom("accounts")
        .select(ACCOUNT_COLUMNS)
        .where("email", "=", email)
        .executeTakeFirst();
      return row ? toAccount(row) : null;
    },

    async createAccount({ account, session, identity }) {
      try {
        await database.batch([
          db.insertInto("accounts").values({
            id: account.id,
            email: account.email,
            password_hash: account.passwordHash ?? NO_PASSWORD,
            email_verified_at: account.emailVerifiedAt,
            created_at: account.createdAt,
            updated_at: account.updatedAt,
          }),
          db.insertInto("sessions").values(fromSession(session)),
          ...(identity
            ? [
                db.insertInto("account_identities").values({
                  provider: identity.provider,
                  subject: identity.subject,
                  account_id: identity.accountId,
                  issuer: identity.issuer,
                  email_at_link: identity.emailAtLink,
                  created_at: identity.createdAt,
                  last_used_at: identity.lastUsedAt,
                }),
              ]
            : []),
        ]);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Which constraint: the address, or the issuer identity (a concurrent sign-up).
        const taken = await db
          .selectFrom("accounts")
          .select("id")
          .where("email", "=", account.email)
          .executeTakeFirst();
        throw new UniqueViolationError(taken ? "email" : "identity", { cause: error });
      }
    },

    async changeEmail(accountId, email, now) {
      try {
        await db
          .updateTable("accounts")
          .set({ email, email_verified_at: null, updated_at: now })
          .where("id", "=", accountId)
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) throw new UniqueViolationError("email", { cause: error });
        throw error;
      }
    },

    async markEmailVerified(accountId, email, now) {
      const result = await db
        .updateTable("accounts")
        .set((eb) => ({ email_verified_at: eb.fn.coalesce("email_verified_at", eb.val(now)) }))
        .where("id", "=", accountId)
        .where("email", "=", email)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async findIdentity(provider, subject) {
      const row = await db
        .selectFrom("account_identities")
        .selectAll()
        .where("provider", "=", provider)
        .where("subject", "=", subject)
        .executeTakeFirst();
      return row ? toIdentity(row) : null;
    },

    async listIdentities(accountId) {
      const rows = await db
        .selectFrom("account_identities")
        .selectAll()
        .where("account_id", "=", accountId)
        .orderBy("created_at")
        .orderBy(binary("provider"))
        .execute();
      return rows.map(toIdentity);
    },

    async linkIdentity(identity) {
      try {
        // Inserted only while the account has no identity of this provider: one statement.
        const [inserted] = await database.batch([
          db
            .insertInto("account_identities")
            .columns([
              "provider",
              "subject",
              "account_id",
              "issuer",
              "email_at_link",
              "created_at",
              "last_used_at",
            ])
            .expression(
              db
                .selectNoFrom((eb) => [
                  eb.val(identity.provider).as("provider"),
                  eb.val(identity.subject).as("subject"),
                  eb.val(identity.accountId).as("account_id"),
                  eb.val(identity.issuer).as("issuer"),
                  eb.val(identity.emailAtLink).as("email_at_link"),
                  eb.val(identity.createdAt).as("created_at"),
                  eb.val(identity.lastUsedAt).as("last_used_at"),
                ])
                .where((eb) =>
                  eb.not(
                    eb.exists(
                      db
                        .selectFrom("account_identities")
                        .select("account_identities.subject")
                        .where("account_identities.account_id", "=", identity.accountId)
                        .where("account_identities.provider", "=", identity.provider),
                    ),
                  ),
                ),
            ),
        ]);
        return inserted.numAffectedRows === 1;
      } catch (error) {
        if (isUniqueViolation(error)) throw new UniqueViolationError("identity", { cause: error });
        throw error;
      }
    },

    async touchIdentity(provider, subject, now) {
      await db
        .updateTable("account_identities")
        .set({ last_used_at: now })
        .where("provider", "=", provider)
        .where("subject", "=", subject)
        .execute();
    },

    async unlinkIdentity(accountId, provider, now) {
      // Only while another way to sign in remains: a password, or another identity. The removal
      // is recorded under the same condition, in the same batch, before the row goes.
      // biome-ignore lint/suspicious/noExplicitAny: the same WHERE on both statements.
      const removable = (query: any) =>
        query
          .where("account_identities.account_id", "=", accountId)
          .where("account_identities.provider", "=", provider)
          // biome-ignore lint/suspicious/noExplicitAny: Kysely's expression builder.
          .where((eb: any) =>
            eb.or([
              eb.exists(
                eb
                  .selectFrom("accounts")
                  .select("accounts.id")
                  .where("accounts.id", "=", accountId)
                  .where("accounts.password_hash", "<>", NO_PASSWORD),
              ),
              eb(
                eb
                  .selectFrom("account_identities as other")
                  .select((inner: { fn: { countAll: () => { as: (name: string) => unknown } } }) =>
                    inner.fn.countAll().as("n"),
                  )
                  .where("other.account_id", "=", accountId),
                ">",
                1,
              ),
            ]),
          );
      const [, deleted] = await database.batch([
        recordRemovals("unlinked", now, removable),
        removable(db.deleteFrom("account_identities")),
      ]);
      if (deleted.numAffectedRows > 0) return "unlinked";
      const exists = await db
        .selectFrom("account_identities")
        .select("subject")
        .where("account_id", "=", accountId)
        .where("provider", "=", provider)
        .executeTakeFirst();
      return exists ? "last" : "not_found";
    },

    async findRemoval(provider, subject) {
      const row = await db
        .selectFrom("identity_removals")
        .selectAll()
        .where("provider", "=", provider)
        .where("subject", "=", subject)
        .executeTakeFirst();
      return row
        ? {
            accountId: row.account_id,
            reason: row.reason as "unlinked" | "password_reset",
            removedAt: row.removed_at,
          }
        : null;
    },

    async getSession(sessionId, now) {
      const row = await db
        .selectFrom("sessions")
        .selectAll()
        .where("id", "=", sessionId)
        .where("expires_at", ">", now)
        .executeTakeFirst();
      return row ? { session: toSession(row), elevatedUntil: row.elevated_until } : null;
    },

    async elevateSession(sessionId, accountId, until, now) {
      const result = await db
        .updateTable("sessions")
        .set({ elevated_until: until })
        .where("id", "=", sessionId)
        .where("account_id", "=", accountId)
        .where("expires_at", ">", now)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async createToken(token) {
      await db
        .insertInto("account_tokens")
        .values({
          token_hash: token.tokenHash,
          account_id: token.accountId,
          purpose: token.purpose,
          email: token.email,
          expires_at: token.expiresAt,
          used_at: token.usedAt,
          created_at: token.createdAt,
        })
        .execute();
    },

    async findLiveToken(tokenHash, purpose, now) {
      const row = await db
        .selectFrom("account_tokens as t")
        .innerJoin("accounts as a", (join) =>
          join.onRef("a.id", "=", "t.account_id").onRef("a.email", "=", "t.email"),
        )
        .selectAll("t")
        .where("t.token_hash", "=", tokenHash)
        .where("t.purpose", "=", purpose)
        .where("t.used_at", "is", null)
        .where("t.expires_at", ">", now)
        .executeTakeFirst();
      return row ? toToken(row) : null;
    },

    async consumeVerificationToken(tokenHash, now) {
      const [, consumed] = await database.batch([
        db
          .updateTable("accounts")
          .set((eb) => ({ email_verified_at: eb.fn.coalesce("email_verified_at", eb.val(now)) }))
          .where("id", "in", liveTokenAccount(tokenHash, "verify_email", now)),
        consumeToken(tokenHash, "verify_email", now),
      ]);
      if (consumed.numAffectedRows !== 1) return null;
      const row = await db
        .selectFrom("account_tokens")
        .select("account_id")
        .where("token_hash", "=", tokenHash)
        .executeTakeFirst();
      return row?.account_id ?? null;
    },

    async completePasswordReset({ tokenHash, passwordHash, now }) {
      const token = await db
        .selectFrom("account_tokens")
        .select(["account_id", "email"])
        .where("token_hash", "=", tokenHash)
        .executeTakeFirst();
      if (!token) return null;
      const before = await db
        .selectFrom("account_identities")
        .select(["provider", "email_at_link"])
        .where("account_id", "=", token.account_id)
        .execute();
      const live = () => liveTokenAccount(tokenHash, "reset_password", now);
      const results = await database.batch([
        db
          .updateTable("accounts")
          .set((eb) => ({
            password_hash: passwordHash,
            email_verified_at: eb.fn.coalesce("email_verified_at", eb.val(now)),
            updated_at: now,
          }))
          .where("id", "in", live()),
        db.deleteFrom("sessions").where("account_id", "in", live()),
        // Identities linked under another address than the one the link just proved: recorded as
        // removed (never auto-linked again), then deleted.
        recordRemovals("password_reset", now, (query) =>
          query
            .where("account_identities.account_id", "in", live())
            // biome-ignore lint/suspicious/noExplicitAny: Kysely's expression builder.
            .where((eb: any) =>
              eb.or([
                eb("account_identities.email_at_link", "is", null),
                eb("account_identities.email_at_link", "<>", token.email),
              ]),
            ),
        ),
        db
          .deleteFrom("account_identities")
          .where("account_id", "in", live())
          .where((eb) =>
            eb.or([eb("email_at_link", "is", null), eb("email_at_link", "<>", token.email)]),
          ),
        consumeToken(tokenHash, "reset_password", now),
        // Every other open reset link of the account dies with this one.
        db
          .updateTable("account_tokens")
          .set({ used_at: now })
          .where("purpose", "=", "reset_password")
          .where("used_at", "is", null)
          .where("account_id", "in", (eb) =>
            eb
              .selectFrom("account_tokens as done")
              .select("done.account_id")
              .where("done.token_hash", "=", tokenHash)
              .where("done.used_at", "=", now),
          ),
      ]);
      if (results[4].numAffectedRows !== 1) return null;
      return {
        accountId: token.account_id,
        email: token.email,
        unlinked: before
          .filter((identity) => identity.email_at_link !== token.email)
          .map((identity) => identity.provider as OidcProvider),
      };
    },

    async recordEmail(entry) {
      const [result] = await database.batch([
        db
          .insertInto("email_outbox")
          .values({
            id: entry.id,
            idempotency_key: entry.idempotencyKey,
            to_address: entry.to.toLowerCase(),
            from_address: entry.from,
            template: entry.template,
            subject: entry.subject,
            html_body: entry.html,
            text_body: entry.text,
            status: entry.status,
            provider_message_id: entry.providerMessageId,
            attempts: 1,
            last_error: null,
            created_at: entry.createdAt,
            sent_at: entry.sentAt,
          })
          .onConflict((oc) => oc.column("idempotency_key").doNothing()),
      ]);
      if (result.numAffectedRows > 0) return { created: true, id: entry.id };
      const existing = await db
        .selectFrom("email_outbox")
        .select("id")
        .where("idempotency_key", "=", entry.idempotencyKey)
        .executeTakeFirst();
      if (!existing) throw new Error("The outbox refused a message it does not hold");
      return { created: false, id: existing.id };
    },

    async listMailbox(to, since, limit) {
      const rows = await db
        .selectFrom("email_outbox")
        .selectAll()
        .where("to_address", "=", to.toLowerCase())
        .where("created_at", ">=", since)
        .where("html_body", "is not", null)
        .where("text_body", "is not", null)
        .orderBy("created_at")
        .orderBy(binary("id"))
        .limit(limit)
        .execute();
      return rows.map(toOutbox);
    },

    async isSuppressed(address) {
      const row = await db
        .selectFrom("email_suppressions")
        .select("address")
        .where("address", "=", address.toLowerCase())
        .executeTakeFirst();
      return row !== undefined;
    },

    async forgetAddress(address) {
      const wanted = address.toLowerCase();
      await database.batch([
        db.deleteFrom("email_outbox").where("to_address", "=", wanted),
        db.deleteFrom("email_suppressions").where("address", "=", wanted),
      ]);
    },

    async suppress(entry) {
      await db
        .insertInto("email_suppressions")
        .values({
          address: entry.address.toLowerCase(),
          reason: entry.reason,
          source: entry.source,
          created_at: entry.createdAt,
        })
        .onConflict((oc) => oc.column("address").doNothing())
        .execute();
    },

    async claim(key, expiresAt, now) {
      // Inserted, or taken over once the previous claim expired; a live claim wins.
      const [result] = await database.batch([
        db
          .insertInto("identity_claims")
          .values({ claim_key: key, expires_at: expiresAt })
          .onConflict((oc) =>
            oc
              .column("claim_key")
              .doUpdateSet((eb) => ({ expires_at: excluded(eb, "expires_at") }))
              .where("identity_claims.expires_at", "<=", now),
          ),
      ]);
      return result.numAffectedRows > 0;
    },

    async hasClaim(key, now) {
      const row = await db
        .selectFrom("identity_claims")
        .select("claim_key")
        .where("claim_key", "=", key)
        .where("expires_at", ">", now)
        .executeTakeFirst();
      return row !== undefined;
    },

    async deleteExpired(now, limit) {
      const [claims, tokens] = await database.batch([
        db
          .deleteFrom("identity_claims")
          .where("claim_key", "in", (eb) =>
            eb
              .selectFrom("identity_claims as c")
              .select("c.claim_key")
              .where("c.expires_at", "<=", now)
              .orderBy("c.expires_at")
              .limit(limit),
          ),
        db.deleteFrom("account_tokens").where("token_hash", "in", (eb) =>
          eb
            .selectFrom("account_tokens as t")
            .select("t.token_hash")
            .where((inner) =>
              inner.or([inner("t.expires_at", "<=", now), inner("t.used_at", "is not", null)]),
            )
            .orderBy("t.expires_at")
            .limit(limit),
        ),
      ]);
      return claims.numAffectedRows + tokens.numAffectedRows;
    },

    async searchAccounts(query, after, limit) {
      const prefix = query.trim().toLowerCase();
      let select = db
        .selectFrom("accounts")
        .select(ACCOUNT_COLUMNS)
        .where((eb) =>
          eb.or([
            // A prefix without LIKE (D1 caps LIKE patterns at 50 bytes; addresses go to 254).
            eb(sql<string>`substr(email, 1, ${[...prefix].length})`, "=", prefix),
            eb("id", "=", query.trim()),
          ]),
        );
      if (after) {
        select = select.where((eb) =>
          eb.or([
            eb(binary("email"), ">", after.email),
            eb.and([eb("email", "=", after.email), eb(binary("id"), ">", after.id)]),
          ]),
        );
      }
      const rows = await select
        .orderBy(binary("email"))
        .orderBy(binary("id"))
        .limit(limit)
        .execute();
      return rows.map(toAccount);
    },

    async countSessions(accountId, now) {
      const row = await db
        .selectFrom("sessions")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("account_id", "=", accountId)
        .where("expires_at", ">", now)
        .executeTakeFirst();
      return Number(row?.n ?? 0);
    },
  };
}
