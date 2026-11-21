import type { CatalogRepository, CreditRole, SeedRepository, TitleStatRecord } from "@webflix/core";
import { maturityRank } from "@webflix/core";
import type { Compilable } from "kysely";
import { chunkRows, type Database } from "../database.ts";
import type { DB } from "../schema.ts";
import {
  fromEpisode,
  fromProfile,
  fromProgress,
  fromSubscription,
  fromTitle,
  fromVideoAsset,
  jsonOrNull,
  toAvatar,
  toEpisode,
  toEpisodeSummary,
  toTitle,
  toVideoAsset,
} from "./mapping.ts";

export const CATALOG_VERSION_KEY = "catalog.version";

/** Multi-row INSERTs, chunked to stay under the bound-parameter cap. */
export function insertChunks<T extends keyof DB>(
  database: Database,
  table: T,
  rows: readonly DB[T][],
): Compilable<unknown>[] {
  const first = rows[0];
  if (!first) return [];
  const columns = Object.keys(first).length;
  return chunkRows(rows, columns).map((chunk) =>
    // biome-ignore lint/suspicious/noExplicitAny: generic over tables; rows are typed by the caller.
    database.db.insertInto(table).values(chunk as any),
  );
}

export function createCatalogRepository(database: Database): CatalogRepository {
  const { db } = database;
  return {
    async loadSnapshot() {
      const [titles, titleGenres, credits, seasons, episodes, genres, version, assets] =
        await database.batch([
          db.selectFrom("titles").selectAll().orderBy("id"),
          db
            .selectFrom("title_genres")
            .select(["title_id", "genre_id"])
            .orderBy("title_id")
            .orderBy("position"),
          db
            .selectFrom("credits as c")
            .innerJoin("people as p", "p.id", "c.person_id")
            .select(["c.title_id", "c.person_id", "c.role", "c.character", "c.position", "p.name"])
            .orderBy("c.title_id")
            .orderBy("c.role")
            .orderBy("c.position"),
          db.selectFrom("seasons").selectAll().orderBy("title_id").orderBy("number"),
          db
            .selectFrom("episodes")
            .select([
              "id",
              "title_id",
              "season_number",
              "number",
              "seq",
              "name",
              "runtime_sec",
              "video_asset_id",
              "is_playable",
            ])
            .orderBy("title_id")
            .orderBy("seq"),
          db.selectFrom("genres").selectAll().orderBy("position").orderBy("id"),
          db.selectFrom("meta").select("value").where("key", "=", CATALOG_VERSION_KEY),
          db
            .selectFrom("video_assets")
            .select(["id", "max_height"])
            .where("kind", "=", "packaged")
            .where("max_height", "is not", null)
            .orderBy("id"),
        ]);

      const genresByTitle = new Map<string, string[]>();
      for (const row of titleGenres.rows) {
        const list = genresByTitle.get(row.title_id) ?? [];
        list.push(row.genre_id);
        genresByTitle.set(row.title_id, list);
      }
      return {
        version: version.rows[0]?.value ?? "empty",
        genres: genres.rows.map((row) => ({
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description,
          position: row.position,
        })),
        titles: titles.rows.map((row) => toTitle(row, genresByTitle.get(row.id) ?? [])),
        credits: credits.rows.map((row) => ({
          titleId: row.title_id,
          personId: row.person_id,
          role: row.role as CreditRole,
          character: row.character,
          position: row.position,
          personName: row.name,
        })),
        seasons: seasons.rows.map((row) => ({
          titleId: row.title_id,
          number: row.number,
          name: row.name,
          releaseYear: row.release_year,
          episodeCount: row.episode_count,
        })),
        episodes: episodes.rows.map(toEpisodeSummary),
        packagedAssets: assets.rows.map((row) => ({ id: row.id, maxHeight: row.max_height ?? 0 })),
      };
    },

    async listEpisodes(titleId, seasonNumber) {
      const rows = await db
        .selectFrom("episodes")
        .selectAll()
        .where("title_id", "=", titleId)
        .where("season_number", "=", seasonNumber)
        .orderBy("number")
        .execute();
      return rows.map(toEpisode);
    },

    async loadPlaybackMedia({ assetId, episodeIds }) {
      const assetQuery = db.selectFrom("video_assets").selectAll().where("id", "=", assetId);
      if (episodeIds.length === 0) {
        const asset = await assetQuery.executeTakeFirst();
        return { asset: asset ? toVideoAsset(asset) : null, episodes: [] };
      }
      const [asset, episodes] = await database.batch([
        assetQuery,
        db
          .selectFrom("episodes")
          .selectAll()
          .where("id", "in", [...episodeIds]),
      ]);
      const assetRow = asset.rows[0];
      return {
        asset: assetRow ? toVideoAsset(assetRow) : null,
        episodes: episodes.rows.map(toEpisode),
      };
    },

    async listAvatars() {
      const [groups, avatars] = await database.batch([
        db.selectFrom("avatar_groups").selectAll().orderBy("position").orderBy("id"),
        db.selectFrom("avatars").selectAll().orderBy("position").orderBy("id"),
      ]);
      return {
        groups: groups.rows.map((row) => ({ id: row.id, name: row.name, position: row.position })),
        avatars: avatars.rows.map(toAvatar),
      };
    },

    async getAvatar(avatarId) {
      const row = await db
        .selectFrom("avatars")
        .selectAll()
        .where("id", "=", avatarId)
        .executeTakeFirst();
      return row ? toAvatar(row) : null;
    },

    async listTitleIds() {
      const rows = await db.selectFrom("titles").select("id").orderBy("id").execute();
      return rows.map((row) => row.id);
    },
  };
}

export function createSeedRepository(database: Database): SeedRepository {
  const { db } = database;
  return {
    async replaceCatalog(catalog) {
      const now = Date.now();
      await database.batch([
        db.deleteFrom("title_genres"),
        db.deleteFrom("credits"),
        db.deleteFrom("seasons"),
        db.deleteFrom("episodes"),
        db.deleteFrom("video_assets"),
        db.deleteFrom("titles"),
        db.deleteFrom("genres"),
        db.deleteFrom("people"),
        db.deleteFrom("avatars"),
        db.deleteFrom("avatar_groups"),
        ...insertChunks(
          database,
          "genres",
          catalog.genres.map((genre) => ({
            id: genre.id,
            slug: genre.slug,
            name: genre.name,
            description: genre.description,
            position: genre.position,
          })),
        ),
        ...insertChunks(database, "people", catalog.people),
        ...insertChunks(database, "titles", catalog.titles.map(fromTitle)),
        ...insertChunks(
          database,
          "title_genres",
          catalog.titles.flatMap((title) =>
            title.genreIds.map((genreId, position) => ({
              title_id: title.id,
              genre_id: genreId,
              position,
            })),
          ),
        ),
        ...insertChunks(
          database,
          "credits",
          catalog.credits.map((credit) => ({
            title_id: credit.titleId,
            person_id: credit.personId,
            role: credit.role,
            character: credit.character,
            position: credit.position,
          })),
        ),
        ...insertChunks(
          database,
          "seasons",
          catalog.seasons.map((season) => ({
            title_id: season.titleId,
            number: season.number,
            name: season.name,
            release_year: season.releaseYear,
            episode_count: season.episodeCount,
          })),
        ),
        ...insertChunks(database, "episodes", catalog.episodes.map(fromEpisode)),
        ...insertChunks(database, "video_assets", catalog.videoAssets.map(fromVideoAsset)),
        ...insertChunks(
          database,
          "avatar_groups",
          catalog.avatarGroups.map((group) => ({
            id: group.id,
            name: group.name,
            position: group.position,
          })),
        ),
        ...insertChunks(
          database,
          "avatars",
          catalog.avatars.map((avatar) => ({
            id: avatar.id,
            group_id: avatar.groupId,
            name: avatar.name,
            image_url: avatar.imageUrl,
            position: avatar.position,
          })),
        ),
        // Notifications are upserted, not replaced: read receipts of the ones that survive
        // a re-seed stay (they cascade on delete).
        ...chunkRows(catalog.notifications, 10).map((chunk) =>
          db
            .insertInto("notifications")
            .values(
              chunk.map((notification) => ({
                id: notification.id,
                kind: notification.kind,
                title_id: notification.titleId,
                headline: notification.headline,
                body: notification.body,
                image_json: jsonOrNull(notification.image),
                maturity: notification.maturity,
                maturity_rank: maturityRank(notification.maturity),
                created_at: notification.createdAt,
                seed_version: catalog.version,
              })),
            )
            .onConflict((oc) =>
              oc.column("id").doUpdateSet((eb) => ({
                kind: eb.ref("excluded.kind"),
                title_id: eb.ref("excluded.title_id"),
                headline: eb.ref("excluded.headline"),
                body: eb.ref("excluded.body"),
                image_json: eb.ref("excluded.image_json"),
                maturity: eb.ref("excluded.maturity"),
                maturity_rank: eb.ref("excluded.maturity_rank"),
                created_at: eb.ref("excluded.created_at"),
                seed_version: eb.ref("excluded.seed_version"),
              })),
            ),
        ),
        db
          .deleteFrom("notifications")
          .where("seed_version", "is not", null)
          .where("seed_version", "<>", catalog.version),
        db
          .insertInto("meta")
          .values({ key: CATALOG_VERSION_KEY, value: catalog.version, updated_at: now })
          .onConflict((oc) =>
            oc.column("key").doUpdateSet({ value: catalog.version, updated_at: now }),
          ),
      ]);
    },

    async replaceAccount(write) {
      const { account } = write;
      await database.batch([
        // Cascades to the subscription, profiles (and their library), sessions and playback.
        db
          .deleteFrom("accounts")
          .where((eb) => eb.or([eb("email", "=", account.email), eb("id", "=", account.id)])),
        db.insertInto("accounts").values({
          id: account.id,
          email: account.email,
          password_hash: account.passwordHash,
          created_at: account.createdAt,
          updated_at: account.updatedAt,
        }),
        db.insertInto("subscriptions").values(fromSubscription(write.subscription)),
        ...insertChunks(database, "profiles", write.profiles.map(fromProfile)),
        ...insertChunks(
          database,
          "my_list",
          write.myList.map((entry) => ({
            profile_id: entry.profileId,
            title_id: entry.titleId,
            added_at: entry.addedAt,
          })),
        ),
        ...insertChunks(
          database,
          "ratings",
          write.ratings.map((entry) => ({
            profile_id: entry.profileId,
            title_id: entry.titleId,
            value: entry.value,
            rated_at: entry.ratedAt,
          })),
        ),
        ...insertChunks(database, "watch_progress", write.progress.map(fromProgress)),
        ...insertChunks(
          database,
          "watch_history",
          write.history.map((entry) => ({
            id: entry.id,
            profile_id: entry.profileId,
            item_id: entry.itemId,
            title_id: entry.titleId,
            episode_id: entry.episodeId,
            watched_at: entry.watchedAt,
          })),
        ),
      ]);
    },

    async replaceBaselineStats(rows: readonly TitleStatRecord[]) {
      await database.batch([
        db.deleteFrom("title_stats").where("source", "=", "seed"),
        ...insertChunks(
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
        ),
      ]);
    },
  };
}
