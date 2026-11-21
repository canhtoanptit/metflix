import {
  HEARTBEAT_CARRY_SEC,
  type LibraryRepository,
  type MetaRepository,
  type NotificationRepository,
  type PlaybackRepository,
  type PlaybackSessionRecord,
  type StatsRepository,
  type TitleDayStats,
} from "@webflix/core";
import { type Compilable, sql } from "kysely";
import { chunkValues, type Database } from "../database.ts";
import type { PlaybackSessionsTable } from "../schema.ts";
import { insertChunks } from "./catalog.ts";
import { fromBool, greatest, least, parseJsonOrNull, toProgress, typed } from "./mapping.ts";

/**
 * A view: one profile credited with at least a minute of a title that day, all its sessions of
 * the title together (docs/RECOMMENDATIONS.md, "Real playback").
 */
const VIEW_THRESHOLD_SEC = 60;

export function createLibraryRepository(database: Database): LibraryRepository {
  const { db } = database;
  return {
    async loadSignals(profileId) {
      const [myList, ratings, progress] = await database.batch([
        db
          .selectFrom("my_list")
          .select(["title_id", "added_at"])
          .where("profile_id", "=", profileId)
          .orderBy("added_at", "desc")
          .orderBy("title_id"),
        db
          .selectFrom("ratings")
          .select(["title_id", "value", "rated_at"])
          .where("profile_id", "=", profileId)
          .orderBy("rated_at", "desc")
          .orderBy("title_id"),
        db
          .selectFrom("watch_progress")
          .selectAll()
          .where("profile_id", "=", profileId)
          .orderBy("updated_at", "desc")
          .orderBy("item_id"),
      ]);
      return {
        myList: myList.rows.map((row) => ({ titleId: row.title_id, addedAt: row.added_at })),
        ratings: ratings.rows.map((row) => ({
          titleId: row.title_id,
          value: row.value as "dislike" | "like" | "love",
          ratedAt: row.rated_at,
        })),
        progress: progress.rows.map(toProgress),
      };
    },

    async addToMyList(profileId, titleId, now) {
      await db
        .insertInto("my_list")
        .values({ profile_id: profileId, title_id: titleId, added_at: now })
        .onConflict((oc) => oc.columns(["profile_id", "title_id"]).doNothing())
        .execute();
    },

    async removeFromMyList(profileId, titleId) {
      await db
        .deleteFrom("my_list")
        .where("profile_id", "=", profileId)
        .where("title_id", "=", titleId)
        .execute();
    },

    async setRating(profileId, titleId, value, now) {
      await db
        .insertInto("ratings")
        .values({ profile_id: profileId, title_id: titleId, value, rated_at: now })
        .onConflict((oc) =>
          oc.columns(["profile_id", "title_id"]).doUpdateSet({ value, rated_at: now }),
        )
        .execute();
    },

    async clearRating(profileId, titleId) {
      await db
        .deleteFrom("ratings")
        .where("profile_id", "=", profileId)
        .where("title_id", "=", titleId)
        .execute();
    },

    async hideFromContinueWatching(profileId, titleId) {
      await db
        .updateTable("watch_progress")
        .set({ hidden: 1 })
        .where("profile_id", "=", profileId)
        .where("title_id", "=", titleId)
        .execute();
    },

    async listHistory(profileId, { before, limit }) {
      let query = db
        .selectFrom("watch_history")
        .selectAll()
        .where("profile_id", "=", profileId)
        .orderBy("watched_at", "desc")
        .orderBy("id", "desc")
        .limit(limit);
      if (before) {
        query = query.where((eb) =>
          eb.or([
            eb("watched_at", "<", before.watchedAt),
            eb.and([eb("watched_at", "=", before.watchedAt), eb("id", "<", before.id)]),
          ]),
        );
      }
      const rows = await query.execute();
      return rows.map((row) => ({
        id: row.id,
        profileId: row.profile_id,
        itemId: row.item_id,
        titleId: row.title_id,
        episodeId: row.episode_id,
        watchedAt: row.watched_at,
      }));
    },

    async deleteHistoryEntry(profileId, entryId) {
      const [, deleted] = await database.batch([
        db
          .deleteFrom("watch_progress")
          .where("profile_id", "=", profileId)
          .where("item_id", "in", (eb) =>
            eb
              .selectFrom("watch_history")
              .select("item_id")
              .where("id", "=", entryId)
              .where("profile_id", "=", profileId),
          ),
        db
          .deleteFrom("watch_history")
          .where("id", "=", entryId)
          .where("profile_id", "=", profileId),
      ]);
      return deleted.numAffectedRows > 0;
    },
  };
}

function toPlaybackSession(row: PlaybackSessionsTable): PlaybackSessionRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    profileId: row.profile_id,
    sessionId: row.session_id,
    titleId: row.title_id,
    episodeId: row.episode_id,
    assetId: row.asset_id,
    maxVideoHeight: row.max_video_height,
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    endedAt: row.ended_at,
    positionSec: row.position_sec,
    durationSec: row.duration_sec,
    watchedSec: row.watched_sec,
    state: row.state as PlaybackSessionRecord["state"],
  };
}

export function createPlaybackRepository(database: Database): PlaybackRepository {
  const { db, dialect } = database;
  return {
    async create(session) {
      await db
        .insertInto("playback_sessions")
        .values({
          id: session.id,
          account_id: session.accountId,
          profile_id: session.profileId,
          session_id: session.sessionId,
          title_id: session.titleId,
          episode_id: session.episodeId,
          asset_id: session.assetId,
          max_video_height: session.maxVideoHeight,
          started_at: session.startedAt,
          last_heartbeat_at: session.lastHeartbeatAt,
          ended_at: session.endedAt,
          position_sec: session.positionSec,
          duration_sec: session.durationSec,
          watched_sec: session.watchedSec,
          state: session.state,
        })
        .execute();
    },

    async get(playbackSessionId) {
      const row = await db
        .selectFrom("playback_sessions")
        .selectAll()
        .where("id", "=", playbackSessionId)
        .executeTakeFirst();
      return row ? toPlaybackSession(row) : null;
    },

    async recordHeartbeat(write) {
      const itemId = write.episodeId ?? write.titleId;
      // Progress and history are written only while the session is live, so a report that
      // lands after the session ended (a release with the final position won the race) cannot
      // overwrite that position. They come first: the release's own batch ends the session last.
      const live = db
        .selectFrom("playback_sessions")
        .where("id", "=", write.playbackSessionId)
        .where("ended_at", "is", null);
      await database.batch([
        // A no-op write that row-locks the session first. On Postgres (READ COMMITTED) a
        // heartbeat that started while the release was being written waits here, and its
        // statements below then see the session ended: without the lock, its progress upsert
        // would wait on the release's row and overwrite the final position after it commits.
        // SQLite and D1 serialise writers anyway.
        db
          .updateTable("playback_sessions")
          .set((eb) => ({ ended_at: eb.ref("ended_at") }))
          .where("id", "=", write.playbackSessionId),
        db
          .insertInto("watch_progress")
          .columns([
            "profile_id",
            "item_id",
            "title_id",
            "episode_id",
            "position_sec",
            "duration_sec",
            "completed",
            "hidden",
            "updated_at",
          ])
          .expression(
            live.select([
              typed(dialect, write.profileId, "text").as("profile_id"),
              typed(dialect, itemId, "text").as("item_id"),
              typed(dialect, write.titleId, "text").as("title_id"),
              typed(dialect, write.episodeId, "text").as("episode_id"),
              typed(dialect, write.positionSec, "real").as("position_sec"),
              typed(dialect, write.durationSec, "real").as("duration_sec"),
              typed(dialect, fromBool(write.completed), "bool").as("completed"),
              typed(dialect, 0, "bool").as("hidden"),
              typed(dialect, write.now, "time").as("updated_at"),
            ]),
          )
          .onConflict((oc) =>
            oc.columns(["profile_id", "item_id"]).doUpdateSet({
              position_sec: write.positionSec,
              duration_sec: write.durationSec,
              completed: fromBool(write.completed),
              hidden: 0,
              updated_at: write.now,
            }),
          ),
        db
          .insertInto("watch_history")
          .columns(["id", "profile_id", "item_id", "title_id", "episode_id", "watched_at"])
          .expression(
            live.select([
              typed(dialect, write.historyId, "text").as("id"),
              typed(dialect, write.profileId, "text").as("profile_id"),
              typed(dialect, itemId, "text").as("item_id"),
              typed(dialect, write.titleId, "text").as("title_id"),
              typed(dialect, write.episodeId, "text").as("episode_id"),
              typed(dialect, write.now, "time").as("watched_at"),
            ]),
          )
          .onConflict((oc) =>
            oc.columns(["profile_id", "item_id"]).doUpdateSet({ watched_at: write.now }),
          ),
        // Right-hand sides read the row's previous values (standard UPDATE semantics): the
        // credit comes from the previous state, position and credit clock without a read in
        // between, and both columns below see the same credit.
        db
          .updateTable("playback_sessions")
          .set((eb) => {
            const credit = sql<number>`case when ${eb.ref("state")} in ('playing', 'buffering') then ${greatest(
              dialect,
              sql<number>`0`,
              least(
                dialect,
                sql<number>`${write.positionSec} - ${eb.ref("position_sec")}`,
                sql<number>`(${write.now} - ${eb.ref("last_heartbeat_at")}) / 1000.0`,
                sql<number>`${write.maxCreditSec}`,
              ),
            )} else 0 end`;
            return {
              watched_sec: sql<number>`${eb.ref("watched_sec")} + ${credit}`,
              last_heartbeat_at: greatest(
                dialect,
                sql<number>`${eb.ref("last_heartbeat_at")} + round(${credit} * 1000)`,
                sql<number>`${write.now - HEARTBEAT_CARRY_SEC * 1000}`,
              ),
              position_sec: write.positionSec,
              duration_sec: write.durationSec,
              state: write.state,
              ...(write.ends ? { ended_at: write.now } : {}),
            };
          })
          .where("id", "=", write.playbackSessionId)
          .where("ended_at", "is", null),
      ]);
    },

    async end(playbackSessionId, now) {
      await db
        .updateTable("playback_sessions")
        .set({ ended_at: now })
        .where("id", "=", playbackSessionId)
        .where("ended_at", "is", null)
        .execute();
    },

    async deleteStartedBefore(cutoff) {
      const result = await db
        .deleteFrom("playback_sessions")
        .where("started_at", "<", cutoff)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}

export function createStatsRepository(database: Database): StatsRepository {
  const { db } = database;
  return {
    async rollupPlaybackDay(day, fromMs, toMs) {
      await db
        .insertInto("title_stats")
        .columns(["day", "title_id", "source", "views", "watch_sec", "profiles"])
        .expression((eb) =>
          eb
            // Seconds credited per profile and title that day, over all its sessions.
            .selectFrom(
              eb
                .selectFrom("playback_sessions")
                .select((inner) => [
                  "title_id",
                  "profile_id",
                  inner.fn.sum<number>("watched_sec").as("watched"),
                ])
                .where("started_at", ">=", fromMs)
                .where("started_at", "<", toMs)
                .groupBy(["title_id", "profile_id"])
                .as("per_profile"),
            )
            .select((inner) => [
              inner.val(day).as("day"),
              "per_profile.title_id",
              inner.val("playback").as("source"),
              inner.fn
                .count(
                  inner
                    .case()
                    .when("per_profile.watched", ">=", VIEW_THRESHOLD_SEC)
                    .then(inner.ref("per_profile.profile_id"))
                    .end(),
                )
                .as("views"),
              inner.fn.sum("per_profile.watched").as("watch_sec"),
              inner.fn.countAll().as("profiles"),
            ])
            // A WHERE disambiguates SQLite's INSERT ... SELECT ... ON CONFLICT parse.
            .where("per_profile.title_id", "is not", null)
            .groupBy("per_profile.title_id"),
        )
        .onConflict((oc) =>
          oc.columns(["day", "title_id", "source"]).doUpdateSet((eb) => ({
            views: eb.ref("excluded.views"),
            watch_sec: eb.ref("excluded.watch_sec"),
            profiles: eb.ref("excluded.profiles"),
          })),
        )
        .execute();
    },

    async upsertBaseline(rows) {
      const statements: Compilable<unknown>[] = insertChunks(
        database,
        "title_stats",
        rows.map((row) => ({
          day: row.day,
          title_id: row.titleId,
          source: "seed",
          views: row.views,
          watch_sec: row.watchSec,
          profiles: row.profiles,
        })),
      ).map((insert) =>
        (insert as ReturnType<typeof db.insertInto<"title_stats">>).onConflict((oc) =>
          oc.columns(["day", "title_id", "source"]).doUpdateSet((eb) => ({
            views: eb.ref("excluded.views"),
            watch_sec: eb.ref("excluded.watch_sec"),
            profiles: eb.ref("excluded.profiles"),
          })),
        ),
      );
      await database.batch(statements);
    },

    async hasBaseline(day) {
      const row = await db
        .selectFrom("title_stats")
        .select("title_id")
        .where("day", "=", day)
        .where("source", "=", "seed")
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    async dailyViews(fromDay) {
      const rows = await db
        .selectFrom("title_stats")
        .select((eb) => ["day", "title_id", eb.fn.sum<number>("views").as("views")])
        .where("day", ">=", fromDay)
        .groupBy(["day", "title_id"])
        .orderBy("day")
        .orderBy("title_id")
        .execute();
      return rows.map((row) => ({ day: row.day, titleId: row.title_id, views: Number(row.views) }));
    },

    async titleDays(titleId, fromDay) {
      const rows = await db
        .selectFrom("title_stats")
        .select(["day", "source", "views", "watch_sec", "profiles"])
        .where("title_id", "=", titleId)
        .where("day", ">=", fromDay)
        .orderBy("day", "desc")
        .execute();
      const days = new Map<string, TitleDayStats>();
      for (const row of rows) {
        const entry = days.get(row.day) ?? {
          day: row.day,
          baselineViews: 0,
          playbackViews: 0,
          playbackWatchSec: 0,
          playbackProfiles: 0,
        };
        if (row.source === "seed") entry.baselineViews += Number(row.views);
        else {
          entry.playbackViews += Number(row.views);
          entry.playbackWatchSec += Number(row.watch_sec);
          entry.playbackProfiles += Number(row.profiles);
        }
        days.set(row.day, entry);
      }
      return [...days.values()];
    },
  };
}

export function createNotificationRepository(database: Database): NotificationRepository {
  const { db } = database;
  return {
    async listForProfile({ profileId, maxMaturityRank, since, limit }) {
      const rows = await db
        .selectFrom("notifications as n")
        .leftJoin("notification_reads as r", (join) =>
          join.onRef("r.notification_id", "=", "n.id").on("r.profile_id", "=", profileId),
        )
        .select([
          "n.id",
          "n.kind",
          "n.title_id",
          "n.headline",
          "n.body",
          "n.image_json",
          "n.maturity",
          "n.created_at",
          "r.read_at",
        ])
        .where("n.maturity_rank", "<=", maxMaturityRank)
        .where("n.created_at", ">=", since)
        .orderBy("n.created_at", "desc")
        .orderBy("n.id", "desc")
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind as "new-arrival",
        titleId: row.title_id,
        headline: row.headline,
        body: row.body,
        image: parseJsonOrNull(row.image_json),
        maturity: row.maturity as "ALL",
        createdAt: row.created_at,
        readAt: row.read_at,
      }));
    },

    async markRead({ profileId, maxMaturityRank, since }, ids, now) {
      const insert = (restrict?: string[]) =>
        db
          .insertInto("notification_reads")
          .columns(["profile_id", "notification_id", "read_at"])
          .expression((eb) => {
            let select = eb
              .selectFrom("notifications")
              .select((inner) => [
                inner.val(profileId).as("profile_id"),
                "id",
                inner.val(now).as("read_at"),
              ])
              .where("maturity_rank", "<=", maxMaturityRank)
              .where("created_at", ">=", since);
            if (restrict) select = select.where("id", "in", restrict);
            return select;
          })
          .onConflict((oc) => oc.columns(["profile_id", "notification_id"]).doNothing());
      if (ids === "all") {
        await insert().execute();
        return;
      }
      if (ids.length === 0) return;
      await database.batch(chunkValues(ids, 90).map((chunk) => insert(chunk)));
    },
  };
}

export function createMetaRepository(database: Database): MetaRepository {
  const { db } = database;
  return {
    async get(key) {
      const row = await db
        .selectFrom("meta")
        .select("value")
        .where("key", "=", key)
        .executeTakeFirst();
      return row?.value ?? null;
    },
    async set(key, value, now) {
      await db
        .insertInto("meta")
        .values({ key, value, updated_at: now })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now }))
        .execute();
    },
  };
}
