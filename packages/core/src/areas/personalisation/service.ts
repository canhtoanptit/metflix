import type {
  BrowseView,
  EditorialBillboard,
  EditorialCollection,
  EditorialCollectionList,
  JsonValue,
  RecommendationStatus,
  TitleAvailability,
} from "@webflix/contracts";
import * as z from "zod";
import { AppError } from "../../errors.ts";
import type { BlobStore } from "../../ports/blob-store.ts";
import { toIsoString } from "../../ports/clock.ts";
import { defineJob, handleJob } from "../../ports/job-queue.ts";
import { serializeError } from "../../ports/logger.ts";
import { MAX_PROFILE_ERASURE } from "../../ports/recommendation-store.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import { createProfileService } from "../../services/profiles.ts";
import { auditRecord, type StaffAction } from "../experiments/audit.ts";
import type { AreaModule, AreaSeams } from "../module.ts";
import {
  importRecommendations,
  importSizeProblem,
  RecommendationImportError,
  type RecommendationImportResult,
  rollbackRecommendations,
} from "./importer.ts";
import type { EditorialCollectionRecord, TitleAvailabilityRecord } from "./repository.ts";
import { RecommendationServing } from "./serving.ts";
import { createStaffTitles, presentAvailability, type StaffTitles } from "./staff-titles.ts";

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

/** Waits between attempts to tell the shared cache of a new model (then it gives up). */
export const INVALIDATION_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;

/** Withdrawn profile keys read per page when an import collects what it withholds. */
const WITHDRAWN_PAGE = 1_000;

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
export interface PersonalisationService extends AreaModule, StaffTitles {
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
   * KV) and in the caches, and the account's withdrawal record.
   */
  eraseAccountData(accountId: string): Promise<void>;
  /**
   * Data export (§6.3, privacy review M6): the recommendation lists held for the account's
   * profiles now, in every registered run of the mode's store (database rows, or Workers KV on
   * Cloudflare): run, list kinds, title ids, expiry; and whether personalisation is withdrawn.
   */
  exportAccountData(accountId: string): Promise<JsonValue>;
  /**
   * The `AreaSeams.personalisationConsentChanged` seam (privacy review L1): on a withdrawal the
   * account's key and its profiles' keys are recorded (serving gives the profiles the rule
   * engine, `rules`, with no exposure; the importer stores no list for them) and their stored
   * lists are dropped from every run; on a grant the record goes, and the next import brings
   * their lists back. Idempotent; never throws (a failure is logged).
   */
  personalisationConsentChanged(input: {
    accountId: string;
    granted: boolean;
    at: number;
  }): Promise<void>;
  /**
   * A profile became restricted (kids, or a lowered ceiling; the `forgetProfileBehaviour` seam,
   * after the events area queued its erasure): its stored lists are dropped from every run at
   * once. Later imports withhold it while its erasure is unsettled (privacy review M3).
   */
  forgetProfileLists(input: { accountId: string; profileId: string }): Promise<void>;
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
      withheld,
      ...(run ? { run } : {}),
    });
    if (result.status === "unchanged") return result;
    return { ...result, cacheInvalidated: await invalidateServing() };
  }

  /**
   * Tells every cache level that the served model changed, retried briefly: a one-shot process
   * (the importer Job on a new pod) may find the shared cache not reachable yet (finding K15).
   * False after the last attempt; the age bound still serves the change within 30 s.
   */
  async function invalidateServing(): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      if (await serving.invalidate()) return true;
      const delay = INVALIDATION_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        deps.logger.error("recs.cache_invalidation_failed", {
          attempts: attempt + 1,
          detail: "every process serves the change within the model's age bound (30 s)",
        });
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * The keys a run with data up to `asOf` must not store lists for (privacy review M3):
   * erasures the events area still holds unsettled for that cutoff (deleted accounts' profiles,
   * profiles that became restricted), and the profiles of accounts that withdrew
   * personalisation. Keyed by pseudonymous key only (no pseudonym secret needed, so the
   * Cloudflare ops importer reads the same), in keyset pages whatever the run's size.
   */
  async function withheld(asOf: number): Promise<ReadonlySet<string>> {
    const keys = new Set(await seams.withheldSubjects(asOf));
    let after: string | null = null;
    for (;;) {
      const page = await deps.repos.personalisation.withdrawnProfileKeys(after, WITHDRAWN_PAGE);
      for (const key of page) keys.add(key);
      if (page.length < WITHDRAWN_PAGE) return keys;
      after = page[page.length - 1] ?? null;
    }
  }

  /** Drops these profiles' lists from every run, in the store and the caches. */
  async function dropLists(profileKeys: readonly string[]): Promise<void> {
    if (profileKeys.length === 0) return;
    const runs = (await deps.recommendations.models()).map((model) => model.run);
    for (let index = 0; index < profileKeys.length; index += MAX_PROFILE_ERASURE) {
      await deps.recommendations.deleteProfileLists(
        profileKeys.slice(index, index + MAX_PROFILE_ERASURE),
      );
    }
    await serving.forgetProfiles(runs, profileKeys);
  }

  async function accountProfiles(accountId: string) {
    // The identity area's profile listing.
    const { items } = await createProfileService(deps).list(accountId);
    return Promise.all(
      items.map(async (profile) => ({ profile, key: await serving.profileKey(profile.id) })),
    );
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
    // The staff console's catalogue and availability reads (`GET /titles`, `…/availability`).
    ...createStaffTitles(deps),
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
      await invalidateServing();
      return status();
    },

    recommendationStatus: status,

    async requestImport(run) {
      // A run this runtime cannot import in one invocation is refused now, naming the importer
      // that can, instead of failing half-way in the job.
      const blobs = deps.recommendationArtefacts;
      if (blobs && deps.recommendations.importCapacity) {
        // A new run's lists, or everything a rewrite of the served run would do (its writes,
        // its deletions in every run, its key listings). Unreadable artefacts are the job's to
        // report: it records why.
        const problem = await importSizeProblem({
          blobs,
          store: deps.recommendations,
          clock: deps.clock,
          logger: deps.logger,
          withheld,
          ...(run ? { run } : {}),
        }).catch(() => null);
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
      // The profiles still exist when the job calls this.
      const keys = (await accountProfiles(accountId)).map((entry) => entry.key);
      await dropLists(keys);
      await deps.repos.personalisation.clearWithdrawal(await serving.accountKey(accountId));
      await serving.invalidateEditorial();
      deps.logger.info("recs.account_erased", { profiles: keys.length });
    },

    async exportAccountData(accountId) {
      const [profiles, models, withdrawal] = await Promise.all([
        accountProfiles(accountId),
        deps.recommendations.models(),
        serving.accountKey(accountId).then((key) => deps.repos.personalisation.getWithdrawal(key)),
      ]);
      const recommendationLists: JsonValue[] = [];
      for (const { profile, key } of profiles) {
        for (const model of models) {
          // Whatever is held, expired or not (`now` 0): it is what the store keeps.
          const held = await deps.recommendations.profileLists(model.run, key, 0);
          if (!held) continue;
          recommendationLists.push({
            profileId: profile.id,
            profileName: profile.name,
            run: model.run,
            served: model.status === "active",
            generatedAt: toIsoString(held.generatedAt),
            expiresAt: toIsoString(held.expiresAt),
            lists: held.rows.map((row) => ({
              kind: row.type,
              because: row.param,
              titleIds: row.items.map(([titleId]) => titleId),
            })),
          });
        }
      }
      return {
        recommendationLists,
        personalisationWithdrawnAt: withdrawal ? toIsoString(withdrawal.withdrawnAt) : null,
        note: "Recommendation lists computed for your profiles from what they watched, rated and added to My List, under pseudonymous keys, as held now in every run Webflix keeps (the served one and the previous one, for a rollback). Each expires a few days after it was computed; a newer run replaces it. None are kept for kids or restricted profiles, nor after you turn personalised recommendations off.",
      };
    },

    async personalisationConsentChanged({ accountId, granted, at }) {
      try {
        const accountKey = await serving.accountKey(accountId);
        if (granted) {
          await deps.repos.personalisation.clearWithdrawal(accountKey);
        } else {
          const keys = (await accountProfiles(accountId)).map((entry) => entry.key);
          await deps.repos.personalisation.recordWithdrawal({
            accountKey,
            profileKeys: keys,
            withdrawnAt: at,
          });
          // What is stored goes too: kept for nothing once the purpose is withdrawn (and a
          // rollback cannot bring it back).
          await dropLists(keys);
        }
        // This process at once; every other within the editorial copy's bound (30 s).
        await serving.invalidateEditorial();
        deps.logger.info(
          granted ? "recs.personalisation_granted" : "recs.personalisation_withdrawn",
          {},
        );
      } catch (error) {
        deps.logger.error("recs.personalisation_consent_failed", {
          granted,
          error: serializeError(error),
        });
      }
    },

    async forgetProfileLists({ profileId }) {
      await dropLists([await serving.profileKey(profileId)]);
      deps.logger.info("recs.profile_lists_forgotten", {});
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
