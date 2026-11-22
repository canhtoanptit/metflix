/**
 * What staff can do (milestone 2 §8.3), as calls into the services of the area that owns the
 * data, each with its audit entry (audit.ts). Role checks are not here: the HTTP guard enforces
 * each route's `staffRole` from the route table before any of this runs.
 *
 * Least data, decided here:
 * - A member's record (`members.get`) carries no password hash (only `hasPassword`), no token,
 *   no issuer subject, no card details, and invoices without the provider's hosted invoice and
 *   PDF links (bearer links to the member's invoice: staff refund by invoice id, the member keeps
 *   their own links).
 * - Privacy (`privacy.get`): consent and requests, never an export's download link (forced to
 *   null even if a future change of the events area sent one), never the member's behaviour
 *   events (the events area's read-back is not exposed to staff).
 * - Dead letters are listed without their payloads (a payload can hold an email address).
 * - Reading a member's record, their privacy view, or searching members is itself audited
 *   (`member.viewed`, `member.privacy_viewed`, `member.searched` with the query): the entry is
 *   written before the data is returned, so data never leaves without one.
 */
import type {
  AdminPlan,
  AdminPlanList,
  AuditLogEntry,
  AuditQuery,
  BrowseView,
  ConsentState,
  DeadLetter,
  DeadLetterPage,
  EditorialBillboard,
  EditorialCollection,
  EditorialCollectionList,
  ExperimentDefinition,
  ExperimentList,
  ExperimentResults,
  ExportResultsBody,
  JsonValue,
  MemberDetail,
  MemberPrivacy,
  MemberSearchPage,
  MembershipState,
  PendingErasures,
  PendingExports,
  PlanId,
  PlanSyncResult,
  RecommendationImportAnswer,
  RecommendationStatus,
  Refund,
  StaffTitlePage,
  SystemHealth,
  TitleAvailability,
  TitleAvailabilityList,
} from "@webflix/contracts";
import { AppError } from "../../errors.ts";
import { toIsoString } from "../../ports/clock.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import type { ConsentPurposeName } from "../events/repository.ts";
import type { ExperimentDesign } from "../experiments/service.ts";
import type { AreaServices } from "../index.ts";
import {
  inspectRecommendations,
  RECS_POINTER_KEY,
  RecommendationImportError,
} from "../personalisation/importer.ts";
import type { AvailabilityChange, CollectionDesign } from "../personalisation/service.ts";
import { type AuditTrail, asJson, type StaffContext, staffAction } from "./audit.ts";
import type { DeadLetters } from "./dead-letters.ts";

const HEALTH_PROBE_TIMEOUT_MS = 2000;

/** The member a target names (every member action is audited on the account). */
const member = (accountId: string) => ({ type: "member", id: accountId });

export interface StaffOperations {
  members: {
    search(
      context: StaffContext,
      query: { q: string; cursor?: string | undefined; limit?: number | undefined },
    ): Promise<MemberSearchPage>;
    get(context: StaffContext, accountId: string): Promise<MemberDetail>;
    signOutEverywhere(context: StaffContext, accountId: string, reason: string): Promise<void>;
    sendPasswordReset(context: StaffContext, accountId: string, reason: string): Promise<void>;
    removeProfilePin(
      context: StaffContext,
      accountId: string,
      profileId: string,
      reason: string,
    ): Promise<void>;
  };
  privacy: {
    get(context: StaffContext, accountId: string): Promise<MemberPrivacy>;
    setConsent(
      context: StaffContext,
      accountId: string,
      input: { purpose: ConsentPurposeName; granted: boolean; reason: string },
    ): Promise<ConsentState>;
    cancelDeletion(context: StaffContext, accountId: string, reason: string): Promise<void>;
    pendingErasures(limit: number): Promise<PendingErasures>;
    confirmErasures(context: StaffContext, subjectKeys: string[], reason: string): Promise<void>;
    pendingExports(limit: number): Promise<PendingExports>;
    recordExportResults(
      context: StaffContext,
      document: ExportResultsDocument,
      reason: string,
    ): Promise<void>;
  };
  billing: {
    refund(
      context: StaffContext,
      accountId: string,
      input: {
        invoiceId: string;
        amount?: { amountMinor: number; currency: string } | undefined;
        reason: string;
        idempotencyKey: string;
      },
    ): Promise<Refund>;
    cancel(
      context: StaffContext,
      accountId: string,
      input: {
        when: "now" | "period_end";
        refundUnused?: boolean | undefined;
        reason: string;
        idempotencyKey: string;
      },
    ): Promise<MembershipState>;
    extendTrial(
      context: StaffContext,
      accountId: string,
      input: { days: number; reason: string; idempotencyKey: string },
    ): Promise<MembershipState>;
    grantComplimentaryPeriod(
      context: StaffContext,
      accountId: string,
      input: { days: number; reason: string; idempotencyKey: string },
    ): Promise<MembershipState>;
    listPlans(): Promise<AdminPlanList>;
    setPlanPrice(
      context: StaffContext,
      input: { planId: PlanId; currency: string; amountMinor: number; reason: string },
    ): Promise<AdminPlan>;
    syncPlans(context: StaffContext, reason: string): Promise<PlanSyncResult>;
  };
  editorial: {
    searchTitles(query: {
      q?: string | undefined;
      ids?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    }): Promise<StaffTitlePage>;
    listTitleAvailability(): Promise<TitleAvailabilityList>;
    getTitleAvailability(titleId: string): Promise<TitleAvailability>;
    getBillboard(view: BrowseView): Promise<EditorialBillboard>;
    setBillboard(
      context: StaffContext,
      view: BrowseView,
      titleIds: string[],
      reason: string,
    ): Promise<EditorialBillboard>;
    listCollections(): Promise<EditorialCollectionList>;
    createCollection(
      context: StaffContext,
      design: CollectionDesign,
      reason: string,
    ): Promise<EditorialCollection>;
    updateCollection(
      context: StaffContext,
      id: string,
      design: CollectionDesign,
      reason: string,
    ): Promise<EditorialCollection>;
    deleteCollection(context: StaffContext, id: string, reason: string): Promise<void>;
    setTitleAvailability(
      context: StaffContext,
      titleId: string,
      change: AvailabilityChange,
      reason: string,
    ): Promise<TitleAvailability>;
  };
  experiments: {
    list(): Promise<ExperimentList>;
    get(key: string): Promise<ExperimentDefinition>;
    create(
      context: StaffContext,
      design: ExperimentDesign,
      reason: string,
    ): Promise<ExperimentDefinition>;
    update(
      context: StaffContext,
      key: string,
      changes: Partial<Omit<ExperimentDesign, "key">>,
      reason: string,
    ): Promise<ExperimentDefinition>;
    setStatus(
      context: StaffContext,
      key: string,
      status: ExperimentDefinition["status"],
      reason: string,
    ): Promise<ExperimentDefinition>;
    results(key: string): Promise<ExperimentResults>;
  };
  system: {
    health(): Promise<SystemHealth>;
    deadLetters(page: {
      cursor?: string | undefined;
      limit?: number | undefined;
    }): Promise<DeadLetterPage>;
    replayDeadLetter(context: StaffContext, id: string, reason: string): Promise<DeadLetter>;
    recommendations(): Promise<RecommendationStatus>;
    importRecommendations(
      context: StaffContext,
      reason: string,
    ): Promise<RecommendationImportAnswer>;
    rollbackRecommendations(context: StaffContext, reason: string): Promise<RecommendationStatus>;
  };
  audit: {
    list(query: AuditQuery): Promise<{ items: AuditLogEntry[]; nextCursor: string | null }>;
    /** The caller's own entries, `before`/`after` withheld (see `AuditTrail.listOwn`). */
    listOwn(
      context: StaffContext,
      query: Omit<AuditQuery, "actorId">,
    ): Promise<{ items: AuditLogEntry[]; nextCursor: string | null }>;
  };
}

/** `export-events`'s results document, as the staff route parsed it (without its `reason`). */
export type ExportResultsDocument = Omit<ExportResultsBody, "reason">;

/** Request ids only: the pattern holds no `/`, `?` or `:`, so no link can pass as one. */
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const requestIds = (ids: readonly string[]) => ids.filter((id) => REQUEST_ID.test(id));

/** Settles within `ms` or rejects with a timeout (a hung dependency must not hang the probe). */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function createStaffOperations(
  deps: ServiceDependencies,
  areas: () => AreaServices,
  trail: AuditTrail,
  deadLetters: DeadLetters,
): StaffOperations {
  const { clock } = deps;

  /**
   * A change of a self-auditing area (experiments, personalisation): the area writes the entry
   * in the batch of its change; a failure gets an entry of its own.
   */
  async function selfAudited<T>(
    context: StaffContext,
    spec: { action: string; target: { type: string; id: string }; reason: string },
    parameters: JsonValue,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      await trail.recordFailure(context, { ...spec, parameters, error });
      throw error;
    }
  }

  /** `not_found` for an account that does not exist (the identity area decides). */
  const requireMember = (accountId: string) => areas().identity.getMemberIdentity(accountId);

  const members: StaffOperations["members"] = {
    async search(context, query) {
      const { identity, billing } = areas();
      const found = await identity.searchMembers(query);
      const memberships = await billing.membershipSummaries(found.items.map((m) => m.accountId));
      const page: MemberSearchPage = {
        items: found.items.map((item) => {
          const membership = memberships.get(item.accountId);
          return {
            accountId: item.accountId,
            email: item.email,
            createdAt: item.createdAt,
            membershipStatus: membership?.membershipStatus ?? "none",
            planId: membership?.planId ?? null,
            isDemo: item.isDemo,
          };
        }),
        nextCursor: found.nextCursor,
      };
      await trail.recordRead(
        context,
        "member.searched",
        { type: "member_search", id: query.q },
        { results: page.items.length, more: page.nextCursor !== null },
      );
      return page;
    },

    async get(context, accountId) {
      const { identity, billing } = areas();
      const person = await identity.getMemberIdentity(accountId);
      const money = await billing.memberBilling(accountId);
      const detail: MemberDetail = {
        account: { ...person.account },
        identities: person.identities.map((linked) => ({ ...linked })),
        membership: money.membership,
        entitlement: money.entitlement,
        profiles: person.profiles.map((profile) => ({ ...profile })),
        activeDevices: person.activeDevices,
        // Bearer links to the member's invoice at the provider: not for staff (least data).
        recentInvoices: money.recentInvoices.map((invoice) => ({
          ...invoice,
          hostedUrl: null,
          pdfUrl: null,
        })),
      };
      await trail.recordRead(context, "member.viewed", member(accountId));
      return detail;
    },

    async signOutEverywhere(context, accountId, reason) {
      await trail.audited({
        context,
        action: "member.signed_out_everywhere",
        target: member(accountId),
        reason,
        run: () => areas().identity.signOutMemberEverywhere(accountId),
      });
    },

    async sendPasswordReset(context, accountId, reason) {
      await trail.audited({
        context,
        action: "member.password_reset_sent",
        target: member(accountId),
        reason,
        run: () => areas().identity.sendMemberPasswordReset(accountId),
        // The address is the member's own, shown in their record; the entry needs no copy.
        after: () => ({ queued: true }),
      });
    },

    async removeProfilePin(context, accountId, profileId, reason) {
      await trail.audited({
        context,
        action: "member.pin_removed",
        target: member(accountId),
        reason,
        parameters: { profileId },
        run: () => areas().identity.removeMemberProfilePin(accountId, profileId),
        after: ({ hadPin }) => ({ profileId, hadPin, locked: false }),
      });
    },
  };

  const privacy: StaffOperations["privacy"] = {
    async get(context, accountId) {
      const { events } = areas();
      await requireMember(accountId);
      const [consent, requests] = await Promise.all([
        events.staff.consent(accountId),
        events.staff.privacyRequests(accountId),
      ]);
      const view: MemberPrivacy = {
        consent,
        requests: requests.map((request) => ({ ...request, downloadUrl: null })),
      };
      await trail.recordRead(context, "member.privacy_viewed", member(accountId));
      return view;
    },

    setConsent(context, accountId, input) {
      return trail.audited({
        context,
        action: "privacy.consent_recorded",
        target: member(accountId),
        reason: input.reason,
        parameters: { purpose: input.purpose, granted: input.granted },
        run: async () => {
          await requireMember(accountId);
          return areas().events.staff.setConsent(accountId, input.purpose, input.granted);
        },
        after: (state) => asJson(state.purposes),
      });
    },

    async cancelDeletion(context, accountId, reason) {
      await trail.audited({
        context,
        action: "privacy.deletion_canceled",
        target: member(accountId),
        reason,
        run: async () => {
          await requireMember(accountId);
          if (!(await areas().events.staff.cancelDeletion(accountId))) {
            throw new AppError("not_found", { detail: "No deletion is scheduled" });
          }
        },
        after: () => ({ canceled: true }),
      });
    },

    async pendingErasures(limit) {
      return { subjectKeys: await areas().events.staff.pendingErasures(limit) };
    },

    async confirmErasures(context, subjectKeys, reason) {
      const keys = [...new Set(subjectKeys)];
      await trail.audited({
        context,
        action: "privacy.erasures_confirmed",
        target: { type: "event_lake", id: "erasures" },
        reason,
        parameters: { subjectKeys: keys },
        run: () => areas().events.staff.confirmErasures(keys),
        after: () => ({ confirmed: keys.length }),
      });
    },

    // Already `{ requests }`, the shape the pipeline reads.
    pendingExports: (limit) => areas().events.staff.pendingExports(limit),

    async recordExportResults(context, document, reason) {
      await trail.audited({
        context,
        action: "privacy.export_events_recorded",
        target: { type: "event_lake", id: "exports" },
        reason,
        // The parsed document only (unknown members were dropped by validation): request ids,
        // statuses, the job's private document locations, sizes and hashes. Never a link.
        parameters: asJson(document),
        run: () => areas().events.staff.recordExportResults(document),
        // What became of each request, by id (completed, erased, kept listed, ignored); ids only,
        // so nothing the events area might add to its answer reaches the log.
        after: (outcome) => ({
          completed: requestIds(outcome.completed),
          erased: requestIds(outcome.erased),
          kept: requestIds(outcome.kept),
          ignored: requestIds(outcome.ignored),
        }),
      });
    },
  };

  const billing: StaffOperations["billing"] = {
    refund(context, accountId, input) {
      return trail.audited<Refund>({
        context,
        action: "billing.refund",
        target: member(accountId),
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        parameters: { invoiceId: input.invoiceId, amount: input.amount ?? null },
        run: () =>
          areas().billing.refundInvoice({
            accountId,
            invoiceId: input.invoiceId,
            amount: input.amount,
            reason: input.reason,
            staffSubject: context.staff.subject,
          }),
      });
    },

    async cancel(context, accountId, input) {
      // The entry's `after` is the membership and the refund of the unused time (null when
      // none was made), so the money that moved is visible where the action is. A retry is
      // answered from it.
      const outcome = await trail.audited<{ membership: MembershipState; refund: Refund | null }>({
        context,
        action: "billing.subscription_canceled",
        target: member(accountId),
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        parameters: { when: input.when, refundUnused: input.refundUnused ?? false },
        // Cancelling now and refunding the unused time are two provider calls: a refusal of
        // the second leaves the first done, so such an error is `unknown`, not `failed`.
        singleStep: !(input.when === "now" && input.refundUnused === true),
        run: () =>
          areas().billing.cancelForStaff({
            accountId,
            when: input.when,
            refundUnused: input.refundUnused,
            reason: input.reason,
            staffSubject: context.staff.subject,
          }),
      });
      return outcome.membership;
    },

    extendTrial(context, accountId, input) {
      return trail.audited<MembershipState>({
        context,
        action: "billing.trial_extended",
        target: member(accountId),
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        parameters: { days: input.days },
        run: () => areas().billing.extendTrial({ accountId, days: input.days }),
      });
    },

    grantComplimentaryPeriod(context, accountId, input) {
      return trail.audited<MembershipState>({
        context,
        action: "billing.complimentary_period_granted",
        target: member(accountId),
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        parameters: { days: input.days },
        run: () => areas().billing.grantComplimentaryPeriod({ accountId, days: input.days }),
      });
    },

    listPlans: () => areas().billing.listAdminPlans(),

    async setPlanPrice(context, input) {
      const currency = input.currency.toUpperCase();
      const { billing: area } = areas();
      const previous = (await area.listAdminPlans()).items
        .find((plan) => plan.id === input.planId)
        ?.prices.find((price) => price.currency === currency);
      return trail.audited<AdminPlan>({
        context,
        action: "billing.price_set",
        target: { type: "plan_price", id: `${input.planId}.${currency}` },
        reason: input.reason,
        parameters: { amountMinor: input.amountMinor },
        state: previous ? { amountMinor: previous.amountMinor, active: previous.active } : null,
        run: () =>
          area.setPlanPrice({ planId: input.planId, currency, amountMinor: input.amountMinor }),
        after: () => ({ amountMinor: input.amountMinor }),
      });
    },

    syncPlans(context, reason) {
      return trail.audited<PlanSyncResult>({
        context,
        action: "billing.plans_synced",
        target: { type: "plan_catalogue", id: "all" },
        reason,
        run: () => areas().billing.syncPlans(),
      });
    },
  };

  const editorial: StaffOperations["editorial"] = {
    searchTitles: (query) => areas().personalisation.staffTitles(query),
    listTitleAvailability: async () => ({
      items: await areas().personalisation.listTitleAvailability(),
    }),
    getTitleAvailability: (titleId) => areas().personalisation.titleAvailability(titleId),
    getBillboard: (view) => areas().personalisation.getBillboard(view),
    setBillboard(context, view, titleIds, reason) {
      return selfAudited(
        context,
        { action: "editorial.billboard_set", target: { type: "billboard", id: view }, reason },
        { titleIds },
        () => areas().personalisation.setBillboard(view, titleIds, staffAction(context, reason)),
      );
    },
    listCollections: () => areas().personalisation.listCollections(),
    createCollection(context, design, reason) {
      return selfAudited(
        context,
        {
          action: "editorial.collection_create",
          target: { type: "collection", id: "new" },
          reason,
        },
        asJson(design),
        () => areas().personalisation.createCollection(design, staffAction(context, reason)),
      );
    },
    updateCollection(context, id, design, reason) {
      return selfAudited(
        context,
        { action: "editorial.collection_update", target: { type: "collection", id }, reason },
        asJson(design),
        () => areas().personalisation.updateCollection(id, design, staffAction(context, reason)),
      );
    },
    async deleteCollection(context, id, reason) {
      await selfAudited(
        context,
        { action: "editorial.collection_delete", target: { type: "collection", id }, reason },
        null,
        () => areas().personalisation.deleteCollection(id, staffAction(context, reason)),
      );
    },
    setTitleAvailability(context, titleId, change, reason) {
      return selfAudited(
        context,
        { action: "editorial.availability_set", target: { type: "title", id: titleId }, reason },
        asJson(change),
        () =>
          areas().personalisation.setTitleAvailability(
            titleId,
            change,
            staffAction(context, reason),
          ),
      );
    },
  };

  const experiments: StaffOperations["experiments"] = {
    list: () => areas().experiments.listExperiments(),
    get: (key) => areas().experiments.getExperiment(key),
    create(context, design, reason) {
      return selfAudited(
        context,
        { action: "experiment.create", target: { type: "experiment", id: design.key }, reason },
        asJson(design),
        () => areas().experiments.createExperiment(design, staffAction(context, reason)),
      );
    },
    update(context, key, changes, reason) {
      return selfAudited(
        context,
        { action: "experiment.update", target: { type: "experiment", id: key }, reason },
        asJson(changes),
        () => areas().experiments.updateExperiment(key, changes, staffAction(context, reason)),
      );
    },
    setStatus(context, key, status, reason) {
      return selfAudited(
        context,
        { action: "experiment.status", target: { type: "experiment", id: key }, reason },
        { status },
        () => areas().experiments.setExperimentStatus(key, status, staffAction(context, reason)),
      );
    },
    results: (key) => areas().experiments.getExperimentResults(key),
  };

  const recommendations = { type: "recommendations", id: "served" };

  const system: StaffOperations["system"] = {
    async health() {
      const probe = async (name: string, check: () => Promise<unknown>) => {
        try {
          await within(check(), HEALTH_PROBE_TIMEOUT_MS);
          return { name, up: true, checkedAt: toIsoString(clock.now()), detail: null };
        } catch (error) {
          // A fixed vocabulary: a driver's message can name hosts or credentials.
          const detail =
            error instanceof Error && error.message === "timeout" ? "timeout" : "unreachable";
          return { name, up: false, checkedAt: toIsoString(clock.now()), detail };
        }
      };
      const [dependencies, dead] = await Promise.all([
        Promise.all([
          probe("database", () => deps.repos.ping()),
          probe("cache", () => deps.cache.get("admin:health-probe")),
          probe("recommendation-store", () => deps.recommendations.models()),
        ]),
        deadLetters.count(),
      ]);
      // The JobQueue port reports no depth in any mode (Valkey's is on /metrics, `webflix_jobs`).
      return {
        dependencies,
        jobs: { depth: null, deadLetters: dead },
        checkedAt: toIsoString(clock.now()),
      };
    },

    deadLetters: (page) => deadLetters.list(page),

    replayDeadLetter(context, id, reason) {
      return trail.audited<DeadLetter>({
        context,
        action: "system.dead_letter_replayed",
        target: { type: "dead_letter", id },
        reason,
        run: () => deadLetters.replay(id),
      });
    },

    recommendations: () => areas().personalisation.recommendationStatus(),

    importRecommendations(context, reason) {
      return trail.audited<RecommendationImportAnswer>({
        context,
        action: "system.recommendations_import_requested",
        target: recommendations,
        reason,
        run: async () => {
          const { personalisation } = areas();
          const answer = (
            outcome: RecommendationImportAnswer["outcome"],
            run: string | null,
            detail: string | null,
            status: RecommendationStatus,
          ): RecommendationImportAnswer => ({ ...status, outcome, run, detail });
          // What the importer would find, said up front (the pipeline's importer reports
          // "nothing published" as an ordinary outcome; a queued job would only fail later).
          const blobs = deps.recommendationArtefacts;
          if (!blobs) {
            return answer(
              "no_artefact_store",
              null,
              "This deployment has no store to import recommendation runs from.",
              await personalisation.recommendationStatus(),
            );
          }
          if ((await blobs.head(RECS_POINTER_KEY)) === null) {
            return answer(
              "nothing_published",
              null,
              `No run is published (${RECS_POINTER_KEY} is absent).`,
              await personalisation.recommendationStatus(),
            );
          }
          let published: string;
          try {
            published = (await inspectRecommendations(blobs)).run;
          } catch (error) {
            if (!(error instanceof RecommendationImportError)) throw error;
            return answer(
              "invalid",
              null,
              error.message,
              await personalisation.recommendationStatus(),
            );
          }
          const status = await personalisation.recommendationStatus();
          if (status.activeModel?.run === published) {
            return answer("already_served", published, null, status);
          }
          return answer("queued", published, null, await personalisation.requestImport());
        },
        after: (result) => ({ outcome: result.outcome, run: result.run }),
      });
    },

    async rollbackRecommendations(context, reason) {
      const { personalisation } = areas();
      const before = await personalisation.recommendationStatus();
      return trail.audited<RecommendationStatus>({
        context,
        action: "system.recommendations_rolled_back",
        target: recommendations,
        reason,
        state: { activeRun: before.activeModel?.run ?? null },
        run: () => personalisation.rollbackRecommendations(),
      });
    },
  };

  return {
    members,
    privacy,
    billing,
    editorial,
    experiments,
    system,
    audit: {
      list: trail.list,
      listOwn: (context, query) => trail.listOwn(context.staff.subject, query),
    },
  };
}
