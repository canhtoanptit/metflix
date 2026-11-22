import type {
  BrowseView,
  EditorialBillboard,
  EditorialCollection,
  EditorialCollectionList,
  RecommendationStatus,
  TitleAvailability,
} from "@webflix/contracts";
import * as z from "zod";
import { AppError } from "../../errors.ts";
import type { BlobStore } from "../../ports/blob-store.ts";
import { toIsoString } from "../../ports/clock.ts";
import { defineJob, handleJob } from "../../ports/job-queue.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import { createProfileService } from "../../services/profiles.ts";
import { auditRecord, type StaffAction } from "../experiments/audit.ts";
import type { AreaModule, AreaSeams } from "../module.ts";
import {
  importCapacityProblem,
  importRecommendations,
  inspectRecommendations,
  RecommendationImportError,
  type RecommendationImportResult,
  rollbackRecommendations,
} from "./importer.ts";
import type { EditorialCollectionRecord, TitleAvailabilityRecord } from "./repository.ts";
import { RecommendationServing } from "./serving.ts";

/** A curated collection as staff design it (the contract's `CollectionBody` without `reason`). */
export interface CollectionDesign {
  name: string;
  description: string | null;
  view: BrowseView;
  position: number;
  titleIds: string[];
  status: "draft" | "published";
}

/** An availability override (the contract's `SetTitleAvailabilityBody` without `reason`). */
export interface AvailabilityChange {
  available: boolean;
  availableFrom?: string | null | undefined;
  availableUntil?: string | null | undefined;
}

/** Import the published (or the named) recommendation run (`POST /system/recommendations/import`). */
export const recommendationImportJob = defineJob(
  "recommendations.import",
  z.object({
    run: z
      .string()
      .regex(/^\d{8}-\d{6}-[0-9a-f]{8}$/)
      .nullable(),
  }),
);

/**
 * The personalisation area (milestone 2 §7.2): the importer that publishes the pipeline's
 * artefacts into `deps.recommendations`, hybrid serving (`serving`: which policy and which
 * learned candidates a page uses; recommendations/engine.ts stays the authority for every
 * rule), and the staff operations on the served model. Milestone 1's browse, search and engine
 * are this area's too.
 */
export interface PersonalisationService extends AreaModule {
  readonly serving: RecommendationServing;
  /**
   * Import now (the command-line entry and the job): the published run, or `run`. The served
   * model changes for this process at once and for the others within the model cache's TTL.
   */
  importRecommendations(options?: {
    run?: string;
    /** Read the artefacts from here instead of `deps.recommendationArtefacts`. */
    artefacts?: BlobStore;
  }): Promise<RecommendationImportResult>;
  /** Serve the previous run again (one write); `not_found` when there is none. */
  rollbackRecommendations(): Promise<RecommendationStatus>;
  /** The served model and the last import (`GET /system/recommendations`). */
  recommendationStatus(): Promise<RecommendationStatus>;
  /** Queue an import (`POST /system/recommendations/import` answers 202 with the status). */
  requestImport(run?: string): Promise<RecommendationStatus>;

  // --- Editorial (staff routes; handlers, role checks and the audit context are admin's) ----
  getBillboard(view: BrowseView): Promise<EditorialBillboard>;
  setBillboard(
    view: BrowseView,
    titleIds: string[],
    staff: StaffAction,
  ): Promise<EditorialBillboard>;
  listCollections(): Promise<EditorialCollectionList>;
  createCollection(design: CollectionDesign, staff: StaffAction): Promise<EditorialCollection>;
  updateCollection(
    id: string,
    design: CollectionDesign,
    staff: StaffAction,
  ): Promise<EditorialCollection>;
  deleteCollection(id: string, staff: StaffAction): Promise<void>;
  setTitleAvailability(
    titleId: string,
    change: AvailabilityChange,
    staff: StaffAction,
  ): Promise<TitleAvailability>;
  /**
   * Whether staff made a title unavailable now (cached; never throws: unknown means available).
   * For the surfaces outside browse (playback start, title detail, search) to consult.
   */
  isTitleUnavailable(titleId: string): Promise<boolean>;
  /**
   * Account deletion (§6.3, the events area's erasure job, before the account row goes): the
   * per-profile lists of the account's profiles, in every run, in the store (database or Workers
   * KV) and in the caches.
   */
  eraseAccountData(accountId: string): Promise<void>;
}

function presentCollection(record: EditorialCollectionRecord): EditorialCollection {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    view: record.view,
    position: record.position,
    titleIds: [...record.titleIds],
    status: record.status,
    updatedAt: toIsoString(record.updatedAt),
  };
}

function presentAvailability(record: TitleAvailabilityRecord): TitleAvailability {
  return {
    titleId: record.titleId,
    available: record.available,
    availableFrom: record.availableFrom === null ? null : toIsoString(record.availableFrom),
    availableUntil: record.availableUntil === null ? null : toIsoString(record.availableUntil),
    updatedAt: toIsoString(record.updatedAt),
  };
}

export function createPersonalisationService(
  deps: ServiceDependencies,
  seams: AreaSeams,
): PersonalisationService {
  const serving = new RecommendationServing(deps, seams);

  async function status(): Promise<RecommendationStatus> {
    const models = await deps.recommendations.models();
    const active = models.find((model) => model.status === "active") ?? null;
    const last = models[0] ?? null;
    return {
      activeModel: active
        ? {
            run: active.run,
            asOf: toIsoString(active.asOf),
            expiresAt: toIsoString(active.expiresAt),
            importedAt: toIsoString(active.importedAt),
          }
        : null,
      lastImport: last
        ? {
            run: last.run,
            status:
              last.status === "importing"
                ? "running"
                : last.status === "failed"
                  ? "failed"
                  : "succeeded",
            startedAt: toIsoString(last.importedAt),
            finishedAt: last.finishedAt === null ? null : toIsoString(last.finishedAt),
            error: last.error,
          }
        : null,
    };
  }

  async function runImport(
    run?: string,
    artefacts?: BlobStore,
  ): Promise<RecommendationImportResult> {
    const blobs = artefacts ?? deps.recommendationArtefacts;
    if (!blobs) {
      throw new AppError("service_unavailable", {
        detail: "No artefact store is configured for recommendation imports",
      });
    }
    const result = await importRecommendations({
      blobs,
      store: deps.recommendations,
      clock: deps.clock,
      logger: deps.logger,
      ...(run ? { run } : {}),
    });
    if (result.status === "imported") await serving.invalidate();
    return result;
  }

  const editorialRepo = () => deps.repos.personalisation;

  /** Staff may only name titles the catalogue has (`not_found` otherwise). */
  async function assertTitles(titleIds: readonly string[]): Promise<void> {
    const known = new Set(
      (await deps.repos.catalog.loadSnapshot()).titles.map((title) => title.id),
    );
    const unknown = titleIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new AppError("not_found", { detail: `No such title: ${unknown.join(", ")}` });
    }
  }

  function audit(
    staff: StaffAction,
    action: string,
    type: string,
    id: string,
    before: unknown,
    after: unknown,
  ) {
    return auditRecord(
      staff,
      {
        action,
        target: { type, id },
        before: (before ?? null) as never,
        after: (after ?? null) as never,
      },
      deps.ids,
      deps.clock.now(),
    );
  }

  async function changed(): Promise<void> {
    await serving.invalidateEditorial();
  }

  async function saveCollection(
    id: string,
    design: CollectionDesign,
    staff: StaffAction,
    existing: EditorialCollectionRecord | null,
  ): Promise<EditorialCollection> {
    await assertTitles(design.titleIds);
    const now = deps.clock.now();
    const record: EditorialCollectionRecord = {
      id,
      name: design.name,
      description: design.description,
      view: design.view,
      position: design.position,
      status: design.status,
      titleIds: [...design.titleIds],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      updatedBy: staff.actor.id,
    };
    await editorialRepo().saveCollection(
      record,
      audit(
        staff,
        existing ? "editorial.collection_update" : "editorial.collection_create",
        "collection",
        id,
        existing ? presentCollection(existing) : null,
        presentCollection(record),
      ),
    );
    await changed();
    return presentCollection(record);
  }

  return {
    serving,
    jobs: [
      handleJob(recommendationImportJob, async ({ run }) => {
        try {
          await runImport(run ?? undefined);
        } catch (error) {
          // Bad artefacts are recorded on the run (`failed`, with the reason) and retrying
          // cannot fix them; anything else (a store outage) is retried by the queue.
          if (!(error instanceof RecommendationImportError)) throw error;
        }
      }),
    ],
    scheduled: () => [],

    importRecommendations: (options) => runImport(options?.run, options?.artefacts),

    async rollbackRecommendations() {
      const rolled = await rollbackRecommendations(deps.recommendations, deps.clock.now());
      if (!rolled) throw new AppError("not_found", { detail: "No previous run to roll back to" });
      deps.logger.info("recs.rolled_back", rolled);
      await serving.invalidate();
      return status();
    },

    recommendationStatus: status,

    async requestImport(run) {
      // A run this runtime cannot import in one invocation is refused now, naming the importer
      // that can, instead of failing half-way in the job.
      const blobs = deps.recommendationArtefacts;
      const capacity = deps.recommendations.importCapacity;
      if (blobs && capacity) {
        const version = await inspectRecommendations(blobs, run).catch(() => null);
        const active = await deps.recommendations.activeModel();
        const problem =
          version && version.run !== active?.run
            ? importCapacityProblem(version.run, version.profileLists, capacity)
            : null;
        if (problem) throw new AppError("recommendation_import_too_large", { detail: problem });
      }
      await deps.jobs.publish(recommendationImportJob.create({ run: run ?? null }));
      return status();
    },

    async getBillboard(view) {
      const record = await editorialRepo().getBillboard(view);
      return {
        view,
        titleIds: record?.titleIds ?? [],
        updatedAt: record ? toIsoString(record.updatedAt) : null,
      };
    },

    async setBillboard(view, titleIds, staff) {
      await assertTitles(titleIds);
      const before = await editorialRepo().getBillboard(view);
      const now = deps.clock.now();
      const record = {
        view,
        titleIds: [...new Set(titleIds)],
        updatedAt: now,
        updatedBy: staff.actor.id,
      };
      await editorialRepo().setBillboard(
        record,
        audit(
          staff,
          "editorial.billboard_set",
          "billboard",
          view,
          before?.titleIds ?? [],
          record.titleIds,
        ),
      );
      await changed();
      return { view, titleIds: record.titleIds, updatedAt: toIsoString(now) };
    },

    async listCollections() {
      return { items: (await editorialRepo().listCollections()).map(presentCollection) };
    },

    createCollection: (design, staff) => saveCollection(deps.ids.next(), design, staff, null),

    async updateCollection(id, design, staff) {
      const existing = await editorialRepo().getCollection(id);
      if (!existing) throw new AppError("not_found", { detail: "No such collection" });
      return saveCollection(id, design, staff, existing);
    },

    async deleteCollection(id, staff) {
      const existing = await editorialRepo().getCollection(id);
      if (!existing) throw new AppError("not_found", { detail: "No such collection" });
      const deleted = await editorialRepo().deleteCollection(
        id,
        audit(
          staff,
          "editorial.collection_delete",
          "collection",
          id,
          presentCollection(existing),
          null,
        ),
      );
      if (!deleted) throw new AppError("not_found", { detail: "No such collection" });
      await changed();
    },

    async eraseAccountData(accountId) {
      // The identity area's profile listing; the profiles still exist when the job calls this.
      const { items } = await createProfileService(deps).list(accountId);
      if (items.length === 0) return;
      const keys = await Promise.all(items.map((profile) => serving.profileKey(profile.id)));
      const runs = (await deps.recommendations.models()).map((model) => model.run);
      await deps.recommendations.deleteProfileLists(keys);
      await serving.forgetProfiles(runs, keys);
      deps.logger.info("recs.account_erased", { profiles: keys.length, runs: runs.length });
    },

    async isTitleUnavailable(titleId) {
      return (await serving.editorial(deps.clock.now()))?.unavailable.has(titleId) ?? false;
    },

    async setTitleAvailability(titleId, change, staff) {
      await assertTitles([titleId]);
      const before = await editorialRepo().getAvailability(titleId);
      const now = deps.clock.now();
      const parse = (value: string | null | undefined) =>
        value === null || value === undefined ? null : Date.parse(value);
      const record: TitleAvailabilityRecord = {
        titleId,
        available: change.available,
        availableFrom: parse(change.availableFrom),
        availableUntil: parse(change.availableUntil),
        updatedAt: now,
        updatedBy: staff.actor.id,
      };
      if (
        record.availableFrom !== null &&
        record.availableUntil !== null &&
        record.availableUntil <= record.availableFrom
      ) {
        throw new AppError("validation_failed", {
          detail: "availableUntil must be after availableFrom",
          issues: [
            {
              location: "body",
              path: "availableUntil",
              message: "must be after availableFrom",
              code: "availability_window",
            },
          ],
        });
      }
      await editorialRepo().setAvailability(
        record,
        audit(
          staff,
          "editorial.availability_set",
          "title",
          titleId,
          before ? presentAvailability(before) : null,
          presentAvailability(record),
        ),
      );
      await changed();
      return presentAvailability(record);
    },
  };
}
