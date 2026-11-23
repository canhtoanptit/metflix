import type { BrowseView } from "@webflix/contracts";
import {
  type AuditRecord,
  assertNeighbours,
  assertProfileLists,
  decodeProfileLists,
  type EditorialBillboardRecord,
  type EditorialCollectionRecord,
  encodeProfileLists,
  MAX_PROFILE_ERASURE,
  type Neighbour,
  type NewRecommendationModel,
  type PersonalisationRepository,
  type ProfileLists,
  type RecommendationModel,
  type RecommendationModelStatus,
  type RecommendationStore,
  type TitleAvailabilityRecord,
} from "@webflix/core";
import { chunkRows, type Database, withUnavailableErrors } from "../../database.ts";
import type {
  EditorialBillboardsTable,
  EditorialCollectionItemsTable,
  EditorialCollectionsTable,
  RecommendationModelsTable,
  TitleAvailabilityTable,
} from "../../tables/personalisation.ts";
import { fromBool, json, parseJson, toBool } from "../mapping.ts";
import { auditLogRow, conditionalAuditInsert } from "./experiments.ts";

/**
 * The personalisation area's editorial repository on every dialect (SQLite, PostgreSQL, D1):
 * billboards, curated collections and availability overrides. Each staff change is one batch
 * with its audit row; serving reads all of it in one batch (`loadEditorial`).
 */
export function createPersonalisationRepository(database: Database): PersonalisationRepository {
  const { db } = database;

  const toBillboard = (row: EditorialBillboardsTable): EditorialBillboardRecord => ({
    view: row.view as BrowseView,
    titleIds: parseJson<string[]>(row.title_ids_json),
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by,
  });
  const toAvailability = (row: TitleAvailabilityTable): TitleAvailabilityRecord => ({
    titleId: row.title_id,
    available: toBool(row.available),
    availableFrom: row.available_from === null ? null : Number(row.available_from),
    availableUntil: row.available_until === null ? null : Number(row.available_until),
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by,
  });
  function toCollections(
    rows: EditorialCollectionsTable[],
    items: EditorialCollectionItemsTable[],
  ): EditorialCollectionRecord[] {
    const byCollection = new Map<string, string[]>();
    for (const item of [...items].sort((a, b) => Number(a.position) - Number(b.position))) {
      const list = byCollection.get(item.collection_id) ?? [];
      list.push(item.title_id);
      byCollection.set(item.collection_id, list);
    }
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      view: row.view as BrowseView,
      position: Number(row.position),
      status: row.status as EditorialCollectionRecord["status"],
      titleIds: byCollection.get(row.id) ?? [],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      updatedBy: row.updated_by,
    }));
  }
  const collectionsQuery = () =>
    db
      .selectFrom("editorial_collections")
      .selectAll()
      .orderBy("view")
      .orderBy("position")
      .orderBy("id");
  const audit = (record: AuditRecord) => db.insertInto("audit_log").values(auditLogRow(record));

  return {
    async loadEditorial() {
      const [billboards, collections, items, availability, withdrawn] = await database.batch([
        db.selectFrom("editorial_billboards").selectAll().orderBy("view"),
        collectionsQuery().where("status", "=", "published"),
        db
          .selectFrom("editorial_collection_items as i")
          .innerJoin("editorial_collections as c", "c.id", "i.collection_id")
          .selectAll("i")
          .where("c.status", "=", "published"),
        db.selectFrom("title_availability").selectAll().orderBy("title_id"),
        db
          .selectFrom("recommendation_withdrawals")
          .select("subject_key")
          .where("kind", "=", "account")
          .orderBy("subject_key"),
      ]);
      return {
        billboards: billboards.rows.map(toBillboard),
        collections: toCollections(collections.rows, items.rows),
        availability: availability.rows.map(toAvailability),
        withdrawnAccounts: withdrawn.rows.map((row) => row.subject_key),
      };
    },

    async recordWithdrawal(withdrawal) {
      const rows = [
        { kind: "account", subject_key: withdrawal.accountKey },
        ...withdrawal.profileKeys.map((key) => ({ kind: "profile", subject_key: key })),
      ].map((row) => ({
        ...row,
        account_key: withdrawal.accountKey,
        withdrawn_at: withdrawal.withdrawnAt,
      }));
      // 4 bound parameters per row: 25 rows per INSERT; an existing row keeps its first time.
      await database.batch(
        chunkRows(rows, 4).map((chunk) =>
          db
            .insertInto("recommendation_withdrawals")
            .values(chunk)
            .onConflict((oc) => oc.column("subject_key").doNothing()),
        ),
      );
    },

    async clearWithdrawal(accountKey) {
      await db
        .deleteFrom("recommendation_withdrawals")
        .where("account_key", "=", accountKey)
        .execute();
    },

    async getWithdrawal(accountKey) {
      const rows = await db
        .selectFrom("recommendation_withdrawals")
        .selectAll()
        .where("account_key", "=", accountKey)
        .orderBy("subject_key")
        .execute();
      const account = rows.find((row) => row.kind === "account");
      if (!account) return null;
      return {
        accountKey,
        profileKeys: rows.filter((row) => row.kind === "profile").map((row) => row.subject_key),
        withdrawnAt: Number(account.withdrawn_at),
      };
    },

    async withdrawnProfileKeys(after, limit) {
      let query = db
        .selectFrom("recommendation_withdrawals")
        .select("subject_key")
        .where("kind", "=", "profile");
      if (after !== null) query = query.where("subject_key", ">", after);
      const rows = await query.orderBy("subject_key").limit(limit).execute();
      return rows.map((row) => row.subject_key);
    },

    async getBillboard(view) {
      const row = await db
        .selectFrom("editorial_billboards")
        .selectAll()
        .where("view", "=", view)
        .executeTakeFirst();
      return row ? toBillboard(row) : null;
    },

    async setBillboard(record, row) {
      const values = {
        view: record.view,
        title_ids_json: json(record.titleIds),
        updated_at: record.updatedAt,
        updated_by: record.updatedBy,
      };
      await database.batch([
        db
          .insertInto("editorial_billboards")
          .values(values)
          .onConflict((oc) =>
            oc.column("view").doUpdateSet({
              title_ids_json: values.title_ids_json,
              updated_at: values.updated_at,
              updated_by: values.updated_by,
            }),
          ),
        audit(row),
      ]);
    },

    async listCollections() {
      const [collections, items] = await database.batch([
        collectionsQuery(),
        db.selectFrom("editorial_collection_items").selectAll(),
      ]);
      return toCollections(collections.rows, items.rows);
    },

    async getCollection(id) {
      const [collections, items] = await database.batch([
        collectionsQuery().where("id", "=", id),
        db.selectFrom("editorial_collection_items").selectAll().where("collection_id", "=", id),
      ]);
      return toCollections(collections.rows, items.rows)[0] ?? null;
    },

    async saveCollection(record, row) {
      const values = {
        id: record.id,
        name: record.name,
        description: record.description,
        view: record.view,
        position: record.position,
        status: record.status,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        updated_by: record.updatedBy,
      };
      const { id: _id, created_at: _createdAt, ...changes } = values;
      await database.batch([
        db
          .insertInto("editorial_collections")
          .values(values)
          .onConflict((oc) => oc.column("id").doUpdateSet(changes)),
        db.deleteFrom("editorial_collection_items").where("collection_id", "=", record.id),
        ...chunkRows(
          record.titleIds.map((titleId, index) => ({
            collection_id: record.id,
            position: index + 1,
            title_id: titleId,
          })),
          3,
        ).map((chunk) => db.insertInto("editorial_collection_items").values(chunk)),
        audit(row),
      ]);
    },

    async deleteCollection(id, row) {
      const exists = db.selectFrom("editorial_collections").select("id").where("id", "=", id);
      const [, , deleted] = await database.batch([
        conditionalAuditInsert(database, row, () => exists),
        db.deleteFrom("editorial_collection_items").where("collection_id", "=", id),
        db.deleteFrom("editorial_collections").where("id", "=", id),
      ]);
      return deleted.numAffectedRows > 0;
    },

    async getAvailability(titleId) {
      const row = await db
        .selectFrom("title_availability")
        .selectAll()
        .where("title_id", "=", titleId)
        .executeTakeFirst();
      return row ? toAvailability(row) : null;
    },

    async setAvailability(record, row) {
      const values = {
        title_id: record.titleId,
        available: fromBool(record.available),
        available_from: record.availableFrom,
        available_until: record.availableUntil,
        updated_at: record.updatedAt,
        updated_by: record.updatedBy,
      };
      const { title_id: _titleId, ...changes } = values;
      await database.batch([
        db
          .insertInto("title_availability")
          .values(values)
          .onConflict((oc) => oc.column("title_id").doUpdateSet(changes)),
        audit(row),
      ]);
    },
  };
}

// --- RecommendationStore on SQL ------------------------------------------------------------------

/** Profile keys per `profileKeys` page. */
const PROFILE_KEYS_PAGE = 1_000;
/** 6 bound parameters per neighbour row, 4 per list row: one INSERT stays within 100. */
const NEIGHBOUR_COLUMNS = 6;
const LIST_COLUMNS = 4;

function toModel(row: RecommendationModelsTable): RecommendationModel {
  return {
    run: row.run,
    status: row.status as RecommendationModelStatus,
    asOf: Number(row.as_of),
    expiresAt: Number(row.expires_at),
    importedAt: Number(row.imported_at),
    activatedAt: row.activated_at === null ? null : Number(row.activated_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    manifestSha256: row.manifest_sha256,
    error: row.error,
  };
}

/**
 * `RecommendationStore` on the database (SQLite in dev, PostgreSQL on k8s, D1 for the models
 * and neighbours on Cloudflare): models in `recommendation_models`, neighbours in
 * `recommendation_neighbours` and lists in `recommendation_profile_lists`, every row keyed by
 * run. The serving read (`servingSnapshot`) is one statement; each write method is one batch.
 */
export function createDatabaseRecommendationStore(database: Database): RecommendationStore {
  const { db } = database;

  async function statusOf(run: string): Promise<RecommendationModelStatus | null> {
    const row = await db
      .selectFrom("recommendation_models")
      .select("status")
      .where("run", "=", run)
      .executeTakeFirst();
    return row ? (row.status as RecommendationModelStatus) : null;
  }

  async function requireBegun(run: string): Promise<RecommendationModelStatus> {
    const status = await statusOf(run);
    if (status === null) throw new Error(`Run ${run} was not begun`);
    return status;
  }

  return withUnavailableErrors({
    async activeModel() {
      const row = await db
        .selectFrom("recommendation_models")
        .selectAll()
        .where("status", "=", "active")
        .executeTakeFirst();
      return row ? toModel(row) : null;
    },

    async models() {
      const rows = await db
        .selectFrom("recommendation_models")
        .selectAll()
        .orderBy("imported_at", "desc")
        .orderBy("run", "desc")
        .execute();
      return rows.map(toModel);
    },

    async servingSnapshot() {
      // One statement: the active model's columns repeat on each of its neighbour rows (a run
      // without neighbours still comes back as one row with null neighbour columns).
      const rows = await db
        .selectFrom("recommendation_models as m")
        .leftJoin("recommendation_neighbours as n", "n.model_version", "m.run")
        .selectAll("m")
        .select(["n.title_id", "n.rank", "n.neighbour_id", "n.score", "n.support"])
        .where("m.status", "=", "active")
        .orderBy("n.title_id")
        .orderBy("n.rank")
        .execute();
      const first = rows[0];
      if (!first) return null;
      const neighbours: Neighbour[] = [];
      for (const row of rows) {
        if (row.title_id === null || row.neighbour_id === null) continue;
        neighbours.push({
          titleId: row.title_id,
          rank: Number(row.rank),
          neighbourId: row.neighbour_id,
          score: Number(row.score),
          support: Number(row.support),
        });
      }
      return { model: toModel(first), neighbours };
    },

    async profileLists(run, profileKey, now) {
      const row = await db
        .selectFrom("recommendation_profile_lists")
        .select(["payload", "expires_at"])
        .where("model_version", "=", run)
        .where("profile_key", "=", profileKey)
        .where("expires_at", ">", now)
        .executeTakeFirst();
      return row ? decodeProfileLists(row.payload) : null;
    },

    async beginImport(model: NewRecommendationModel) {
      if ((await statusOf(model.run)) === "active") {
        throw new Error(`Run ${model.run} is being served`);
      }
      await db
        .insertInto("recommendation_models")
        .values({
          run: model.run,
          status: "importing",
          as_of: model.asOf,
          expires_at: model.expiresAt,
          imported_at: model.importedAt,
          activated_at: null,
          manifest_sha256: model.manifestSha256,
          error: null,
          finished_at: null,
        })
        .onConflict((oc) =>
          oc.column("run").doUpdateSet({
            status: "importing",
            as_of: model.asOf,
            expires_at: model.expiresAt,
            imported_at: model.importedAt,
            manifest_sha256: model.manifestSha256,
            error: null,
            finished_at: null,
          }),
        )
        .execute();
    },

    async putNeighbours(run, rows) {
      assertNeighbours(rows);
      await requireBegun(run);
      await database.batch(
        chunkRows(rows, NEIGHBOUR_COLUMNS).map((chunk) =>
          db
            .insertInto("recommendation_neighbours")
            .values(
              chunk.map((row) => ({
                model_version: run,
                title_id: row.titleId,
                rank: row.rank,
                neighbour_id: row.neighbourId,
                score: row.score,
                support: row.support,
              })),
            )
            .onConflict((oc) =>
              oc.columns(["model_version", "title_id", "rank"]).doUpdateSet((eb) => ({
                neighbour_id: eb.ref("excluded.neighbour_id"),
                score: eb.ref("excluded.score"),
                support: eb.ref("excluded.support"),
              })),
            ),
        ),
      );
    },

    async putProfileLists(run, lists: readonly ProfileLists[]) {
      assertProfileLists(run, lists);
      await requireBegun(run);
      await database.batch(
        chunkRows(lists, LIST_COLUMNS).map((chunk) =>
          db
            .insertInto("recommendation_profile_lists")
            .values(
              chunk.map((list) => ({
                model_version: run,
                profile_key: list.profileKey,
                payload: encodeProfileLists(list),
                expires_at: list.expiresAt,
              })),
            )
            .onConflict((oc) =>
              oc.columns(["model_version", "profile_key"]).doUpdateSet((eb) => ({
                payload: eb.ref("excluded.payload"),
                expires_at: eb.ref("excluded.expires_at"),
              })),
            ),
        ),
      );
    },

    async failImport(run, error) {
      const status = await requireBegun(run);
      if (status === "active") throw new Error(`Run ${run} is being served`);
      await db
        .updateTable("recommendation_models")
        .set({ status: "failed", error: error.slice(0, 2000) })
        .where("run", "=", run)
        .execute();
    },

    async activate(run, now) {
      const status = await statusOf(run);
      if (status === null || status === "failed") {
        throw new Error(`Run ${run} cannot be activated (${status ?? "unknown"})`);
      }
      // One statement flips both rows, so readers never see zero or two active runs.
      await db
        .updateTable("recommendation_models")
        .set((eb) => ({
          status: eb.case().when("run", "=", run).then("active").else("ready").end(),
          activated_at: eb
            .case()
            .when("run", "=", run)
            .then(now)
            .else(eb.ref("activated_at"))
            .end(),
          finished_at: eb
            .case()
            .when(eb.and([eb("run", "=", run), eb("finished_at", "is", null)]))
            .then(now)
            .else(eb.ref("finished_at"))
            .end(),
        }))
        .where((eb) => eb.or([eb("run", "=", run), eb("status", "=", "active")]))
        .execute();
    },

    async deleteProfileLists(profileKeys) {
      if (profileKeys.length > MAX_PROFILE_ERASURE) throw new RangeError("Too many profile keys");
      if (profileKeys.length === 0) return;
      await db
        .deleteFrom("recommendation_profile_lists")
        .where("profile_key", "in", [...profileKeys])
        .execute();
    },

    async profileKeys(run, cursor) {
      let query = db
        .selectFrom("recommendation_profile_lists")
        .select("profile_key")
        .where("model_version", "=", run);
      if (cursor !== null) query = query.where("profile_key", ">", cursor);
      const rows = await query.orderBy("profile_key").limit(PROFILE_KEYS_PAGE).execute();
      const keys = rows.map((row) => row.profile_key);
      return { keys, cursor: keys.length === PROFILE_KEYS_PAGE ? (keys.at(-1) ?? null) : null };
    },

    async recordManifest(run, manifestSha256) {
      await requireBegun(run);
      await db
        .updateTable("recommendation_models")
        .set({ manifest_sha256: manifestSha256 })
        .where("run", "=", run)
        .execute();
    },

    async deleteRun(run) {
      if ((await statusOf(run)) === "active") throw new Error("The active run cannot be deleted");
      // Guarded in SQL too: a run activated meanwhile keeps every row.
      const notActive = db
        .selectFrom("recommendation_models")
        .select("run")
        .where("run", "=", run)
        .where("status", "=", "active");
      await database.batch([
        db
          .deleteFrom("recommendation_neighbours")
          .where("model_version", "=", run)
          .where((eb) => eb.not(eb.exists(notActive))),
        db
          .deleteFrom("recommendation_profile_lists")
          .where("model_version", "=", run)
          .where((eb) => eb.not(eb.exists(notActive))),
        db
          .deleteFrom("recommendation_models")
          .where("run", "=", run)
          .where("status", "!=", "active"),
      ]);
    },
  });
}
