import {
  type AccountRepository,
  type ProfileRepository,
  type SessionRepository,
  UniqueViolationError,
} from "@webflix/core";
import { type RawBuilder, sql, type Updateable } from "kysely";
import { type Database, isUniqueViolation } from "../database.ts";
import type { ProfilesTable } from "../schema.ts";
import {
  fromBool,
  fromProfile,
  fromSession,
  fromSubscription,
  PROFILE_JOIN_COLUMNS,
  type ProfileJoinRow,
  toProfile,
  toSession,
  toSubscription,
} from "./mapping.ts";

async function mapUnique<T>(field: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error)) throw new UniqueViolationError(field, { cause: error });
    throw error;
  }
}

export function createAccountRepository(database: Database): AccountRepository {
  const { db } = database;
  return {
    async emailExists(email) {
      const row = await db
        .selectFrom("accounts")
        .select("id")
        .where("email", "=", email)
        .executeTakeFirst();
      return row !== undefined;
    },

    async findByEmail(email) {
      const row = await db
        .selectFrom("accounts")
        .selectAll()
        .where("email", "=", email)
        .executeTakeFirst();
      return row
        ? {
            id: row.id,
            email: row.email,
            passwordHash: row.password_hash,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }
        : null;
    },

    async get(accountId) {
      const row = await db
        .selectFrom("accounts as a")
        .innerJoin("subscriptions as s", "s.account_id", "a.id")
        .select([
          "a.id",
          "a.email",
          "a.password_hash",
          "a.created_at",
          "a.updated_at",
          "s.account_id",
          "s.plan_id",
          "s.started_at",
          "s.current_period_end",
          "s.canceled_at",
          "s.card_brand",
          "s.card_last4",
          "s.card_exp_month",
          "s.card_exp_year",
          "s.updated_at as s_updated_at",
        ])
        .where("a.id", "=", accountId)
        .executeTakeFirst();
      if (!row) return null;
      return {
        account: {
          id: row.id,
          email: row.email,
          passwordHash: row.password_hash,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        subscription: toSubscription({ ...row, updated_at: row.s_updated_at }),
      };
    },

    async createWithSession({ account, subscription, session }) {
      await mapUnique("email", () =>
        database.batch([
          db.insertInto("accounts").values({
            id: account.id,
            email: account.email,
            password_hash: account.passwordHash,
            created_at: account.createdAt,
            updated_at: account.updatedAt,
          }),
          db.insertInto("subscriptions").values(fromSubscription(subscription)),
          db.insertInto("sessions").values(fromSession(session)),
        ]),
      );
    },

    async updateEmail(accountId, email, now) {
      await mapUnique("email", () =>
        db
          .updateTable("accounts")
          .set({ email, updated_at: now })
          .where("id", "=", accountId)
          .execute(),
      );
    },

    async updatePasswordHash(accountId, passwordHash, now) {
      await db
        .updateTable("accounts")
        .set({ password_hash: passwordHash, updated_at: now })
        .where("id", "=", accountId)
        .execute();
    },

    async changePassword({ accountId, passwordHash, keepSessionId, now }) {
      await database.batch([
        db
          .updateTable("accounts")
          .set({ password_hash: passwordHash, updated_at: now })
          .where("id", "=", accountId),
        db
          .deleteFrom("sessions")
          .where("account_id", "=", accountId)
          .where("id", "<>", keepSessionId),
      ]);
    },

    async saveSubscription(subscription) {
      const row = fromSubscription(subscription);
      const { account_id: _key, ...changes } = row;
      await db
        .insertInto("subscriptions")
        .values(row)
        .onConflict((oc) => oc.column("account_id").doUpdateSet(changes))
        .execute();
    },
  };
}

export function createSessionRepository(database: Database): SessionRepository {
  const { db } = database;
  return {
    async create(session) {
      await db.insertInto("sessions").values(fromSession(session)).execute();
    },

    async findActive(tokenHash, now) {
      // One query: the session, and its profile only if it belongs to the same account.
      const row = await db
        .selectFrom("sessions as s")
        .leftJoin("profiles as p", (join) =>
          join.onRef("p.id", "=", "s.active_profile_id").onRef("p.account_id", "=", "s.account_id"),
        )
        .leftJoin("avatars as av", "av.id", "p.avatar_id")
        .selectAll("s")
        .select(PROFILE_JOIN_COLUMNS)
        // Whether the account has any profile, asked only at the gate (no profile bound): the
        // account holder's test for an account with none. Same statement, no extra round trip.
        .select((eb) =>
          eb
            .case()
            .when("p.id", "is not", null)
            .then(1)
            .else(
              eb
                .case()
                .when(
                  eb.exists(
                    eb
                      .selectFrom("profiles as any_p")
                      .select("any_p.id")
                      .whereRef("any_p.account_id", "=", "s.account_id"),
                  ),
                )
                .then(1)
                .else(0)
                .end(),
            )
            .end()
            .as("account_has_profiles"),
        )
        .where("s.token_hash", "=", tokenHash)
        .where("s.expires_at", ">", now)
        .executeTakeFirst();
      if (!row) return null;
      return {
        session: toSession(row),
        profile: row.p_id === null ? null : toProfile(row as ProfileJoinRow),
        accountHasProfiles: Number(row.account_has_profiles) === 1,
      };
    },

    async touch(sessionId, now) {
      await db
        .updateTable("sessions")
        .set({ last_seen_at: now })
        .where("id", "=", sessionId)
        .execute();
    },

    async setActiveProfile(sessionId, accountId, profileId) {
      const update = db
        .updateTable("sessions")
        .set({ active_profile_id: profileId })
        .where("id", "=", sessionId)
        .where("account_id", "=", accountId);
      const result = await (profileId === null
        ? update
        : update.where((eb) =>
            eb.exists(
              eb
                .selectFrom("profiles")
                .select("profiles.id")
                .where("profiles.id", "=", profileId)
                .where("profiles.account_id", "=", accountId),
            ),
          )
      ).executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async listForAccount(accountId, now) {
      const rows = await db
        .selectFrom("sessions")
        .selectAll()
        .where("account_id", "=", accountId)
        .where("expires_at", ">", now)
        .orderBy("last_seen_at", "desc")
        .orderBy("id", "desc")
        .execute();
      return rows.map(toSession);
    },

    async delete(accountId, sessionId) {
      const result = await db
        .deleteFrom("sessions")
        .where("id", "=", sessionId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },

    async deleteAllForAccount(accountId) {
      await db.deleteFrom("sessions").where("account_id", "=", accountId).execute();
    },

    async deleteExpired(now, limit) {
      // One bounded statement (D1 caps a statement's work; no interactive transaction needed).
      const result = await db
        .deleteFrom("sessions")
        .where("id", "in", (eb) =>
          eb
            .selectFrom("sessions")
            .select("id")
            .where("expires_at", "<=", now)
            .orderBy("expires_at")
            .orderBy("id")
            .limit(limit),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}

export function createProfileRepository(database: Database): ProfileRepository {
  const { db, dialect } = database;

  /** `settings_json` with only these keys replaced (a concurrent change of another key stays). */
  const mergeJson = (entries: Array<[string, unknown]>): RawBuilder<string> =>
    dialect === "postgres"
      ? sql<string>`(settings_json::jsonb || ${JSON.stringify(Object.fromEntries(entries))}::jsonb)::text`
      : sql<string>`json_set(settings_json, ${sql.join(
          entries.map(([key, value]) => sql`${`$.${key}`}, json(${JSON.stringify(value)})`),
        )})`;
  const profiles = () =>
    db
      .selectFrom("profiles as p")
      .leftJoin("avatars as av", "av.id", "p.avatar_id")
      .select(PROFILE_JOIN_COLUMNS);

  return {
    async list(accountId) {
      const rows = await profiles()
        .where("p.account_id", "=", accountId)
        .orderBy("p.created_at")
        .orderBy("p.id")
        .execute();
      return rows.map((row) => toProfile(row as ProfileJoinRow));
    },

    async get(accountId, profileId) {
      const row = await profiles()
        .where("p.account_id", "=", accountId)
        .where("p.id", "=", profileId)
        .executeTakeFirst();
      return row ? toProfile(row as ProfileJoinRow) : null;
    },

    async createWithinLimit(profile, maxProfiles) {
      const row = fromProfile(profile);
      const [, insert] = await database.batch([
        // A no-op write that row-locks the account: on Postgres it serialises concurrent
        // creates for the same account, so the count below cannot be raced. SQLite and D1
        // serialise writers anyway.
        db
          .updateTable("accounts")
          .set((eb) => ({ updated_at: eb.ref("updated_at") }))
          .where("id", "=", profile.accountId),
        db
          .insertInto("profiles")
          .columns([
            "id",
            "account_id",
            "name",
            "avatar_id",
            "is_kids",
            "maturity_ceiling",
            "pin_hash",
            "settings_json",
            "created_at",
            "updated_at",
          ])
          .expression(
            db
              .selectNoFrom((eb) => [
                eb.val(row.id).as("id"),
                eb.val(row.account_id).as("account_id"),
                eb.val(row.name).as("name"),
                eb.val(row.avatar_id).as("avatar_id"),
                eb.val(row.is_kids).as("is_kids"),
                eb.val(row.maturity_ceiling).as("maturity_ceiling"),
                eb.val(row.pin_hash).as("pin_hash"),
                eb.val(row.settings_json).as("settings_json"),
                eb.val(row.created_at).as("created_at"),
                eb.val(row.updated_at).as("updated_at"),
              ])
              .where(
                db
                  .selectFrom("profiles")
                  .select((inner) => inner.fn.countAll().as("n"))
                  .where("account_id", "=", row.account_id),
                "<",
                maxProfiles,
              ),
          ),
      ]);
      return insert.numAffectedRows === 1;
    },

    async update(accountId, profileId, patch, options = {}) {
      const columns: Updateable<ProfilesTable> = { updated_at: patch.updatedAt };
      if (patch.name !== undefined) columns.name = patch.name;
      if (patch.avatarId !== undefined) columns.avatar_id = patch.avatarId;
      if (patch.isKids !== undefined) columns.is_kids = fromBool(patch.isKids);
      if (patch.maturityCeiling !== undefined) columns.maturity_ceiling = patch.maturityCeiling;
      if (patch.pinHash !== undefined) columns.pin_hash = patch.pinHash;
      let update = db
        .updateTable("profiles")
        .set(columns)
        .where("id", "=", profileId)
        .where("account_id", "=", accountId);
      const settings = Object.entries(patch.settings ?? {}).filter(
        ([, value]) => value !== undefined,
      );
      if (settings.length > 0) update = update.set({ settings_json: mergeJson(settings) });
      const [updated] = await database.batch([
        update,
        ...(options.unbindSessionsExcept === undefined
          ? []
          : [
              db
                .updateTable("sessions")
                .set({ active_profile_id: null })
                .where("account_id", "=", accountId)
                .where("active_profile_id", "=", profileId)
                .where("id", "<>", options.unbindSessionsExcept),
            ]),
      ]);
      return updated.numAffectedRows > 0;
    },

    async deleteUnlessLast(accountId, profileId) {
      // Dependent rows go with the profile through ON DELETE CASCADE; sessions using it are
      // set back to "no profile" (ON DELETE SET NULL).
      const [, deleted] = await database.batch([
        db
          .updateTable("accounts")
          .set((eb) => ({ updated_at: eb.ref("updated_at") }))
          .where("id", "=", accountId),
        db
          .deleteFrom("profiles")
          .where("id", "=", profileId)
          .where("account_id", "=", accountId)
          .where(
            (eb) =>
              eb
                .selectFrom("profiles as other")
                .select((inner) => inner.fn.countAll().as("n"))
                .where("other.account_id", "=", accountId),
            ">",
            1,
          ),
      ]);
      if (deleted.numAffectedRows > 0) return "deleted";
      const exists = await db
        .selectFrom("profiles")
        .select("id")
        .where("id", "=", profileId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();
      return exists ? "last" : "not_found";
    },
  };
}
