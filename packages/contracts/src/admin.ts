/**
 * The staff (admin) API (docs/BLUEPRINT-M2.md §8.3): request and response schemas of
 * `adminRoutes`. Every mutating action carries a `reason`, kept in the audit log with who acted,
 * on what and with what outcome: in the same batch as the change where the owning area writes it
 * (experiments, editorial data), else written before the action runs and settled after it
 * (members, billing, privacy, system).
 */
import * as z from "zod";
import { Entitlement, Invoice, MembershipState, MembershipStatus } from "./billing.ts";
import { BrowseView } from "./browse.ts";
import { Cursor, Id, IsoDateTime, JsonValue, page } from "./common.ts";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_OUTCOMES,
  EXPERIMENT_STATUSES,
  IDEMPOTENCY_KEY_PATTERN,
  MAX_PAGE_SIZE,
  STAFF_ROLES,
  VIDEO_QUALITIES,
} from "./constants.ts";
import { SubjectKey } from "./events.ts";
import { experimentDefinitionFields } from "./experiments.ts";
import { LinkedIdentity } from "./identity.ts";
import { MaturityLevel } from "./maturity.ts";
import { Money, PlanId } from "./plans.ts";
import { ConsentPurpose, ConsentState, PrivacyRequest } from "./privacy.ts";

export const StaffRoleSchema = z.enum(STAFF_ROLES).meta({ id: "StaffRole" });

/** Who is calling, as the staff verifier mapped the token (roles of the `webflix-admin` client). */
export const StaffIdentity = z
  .object({
    subject: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    roles: z.array(StaffRoleSchema),
  })
  .meta({ id: "StaffIdentity" });
export type StaffIdentity = z.output<typeof StaffIdentity>;

/** Why staff did it: required on every mutating action and kept in the audit log. */
export const AuditReason = z.string().trim().min(3).max(500);

export const ReasonBody = z.object({ reason: AuditReason }).meta({ id: "ReasonBody" });
export type ReasonBody = z.input<typeof ReasonBody>;

/**
 * Required on the billing actions (they move money or free time, so a retry must not apply
 * twice): generate it once per submitted form and send it again on every retry of that form. A
 * retry of a request that succeeded answers its original response; one whose first attempt is
 * still running, failed or ended unknown answers `staff_action_conflict`; the same key with
 * other parameters too.
 */
export const IdempotencyKey = z.string().regex(IDEMPOTENCY_KEY_PATTERN);

const AdminPageQuery = {
  cursor: Cursor.optional(),
  limit: z.coerce.number<number>().int().min(1).max(MAX_PAGE_SIZE).optional(),
};

// --- Members ----------------------------------------------------------------------------------

export const AccountIdParams = z.object({ accountId: Id });

export const MemberSearchQuery = z.object({
  /** An email address (or a prefix of one) or an account id. */
  q: z.string().trim().min(1).max(254),
  ...AdminPageQuery,
});
export type MemberSearchQuery = z.input<typeof MemberSearchQuery>;

export const MemberSummary = z
  .object({
    accountId: Id,
    email: z.string(),
    createdAt: IsoDateTime,
    membershipStatus: MembershipStatus,
    planId: PlanId.nullable(),
    isDemo: z.boolean(),
  })
  .meta({ id: "MemberSummary" });
export type MemberSummary = z.output<typeof MemberSummary>;

export const MemberSearchPage = page(MemberSummary).meta({ id: "MemberSearchPage" });
export type MemberSearchPage = z.output<typeof MemberSearchPage>;

export const MemberDetail = z
  .object({
    account: z.object({
      id: Id,
      email: z.string(),
      emailVerified: z.boolean(),
      hasPassword: z.boolean(),
      createdAt: IsoDateTime,
      isDemo: z.boolean(),
    }),
    identities: z.array(LinkedIdentity),
    membership: MembershipState,
    entitlement: Entitlement,
    profiles: z.array(
      z.object({
        id: Id,
        name: z.string(),
        isKids: z.boolean(),
        maturityCeiling: MaturityLevel,
        locked: z.boolean(),
      }),
    ),
    /** Signed-in devices right now. */
    activeDevices: z.number().int().nonnegative(),
    recentInvoices: z.array(Invoice),
  })
  .meta({ id: "MemberDetail" });
export type MemberDetail = z.output<typeof MemberDetail>;

export const MemberProfileParams = z.object({ accountId: Id, profileId: Id });

// --- Member privacy (§6.3) --------------------------------------------------------------------

/**
 * What support sees of a member's privacy: the consent in force and the member's export and
 * deletion requests. Never an export's download link (`downloadUrl` is always null here) and
 * never the member's behaviour events.
 */
export const MemberPrivacy = z
  .object({
    consent: ConsentState,
    requests: z.array(PrivacyRequest),
  })
  .meta({ id: "MemberPrivacy" });
export type MemberPrivacy = z.output<typeof MemberPrivacy>;

/** Support records the member's own answer, given on the support line (`source: support`). */
export const SetMemberConsentBody = z
  .object({ purpose: ConsentPurpose, granted: z.boolean(), reason: AuditReason })
  .meta({ id: "SetMemberConsentBody" });
export type SetMemberConsentBody = z.input<typeof SetMemberConsentBody>;

/** The operator's side of erasure: what the lake's next compaction must drop (`compact --erase`). */
export const PendingErasuresQuery = z.object({
  limit: z.coerce.number<number>().int().min(1).max(500).optional(),
});
export type PendingErasuresQuery = z.input<typeof PendingErasuresQuery>;

export const PendingErasures = z
  .object({
    /** Pseudonymous account keys, as the lake stores them. */
    subjectKeys: z.array(SubjectKey),
  })
  .meta({ id: "PendingErasures" });
export type PendingErasures = z.output<typeof PendingErasures>;

/** A compaction ran with `--erase` and dropped these keys' events. */
export const ConfirmErasuresBody = z
  .object({ subjectKeys: z.array(SubjectKey).min(1).max(200), reason: AuditReason })
  .meta({ id: "ConfirmErasuresBody" });
export type ConfirmErasuresBody = z.input<typeof ConfirmErasuresBody>;

/**
 * The operator's side of a data export's events (services/recs/README.md, "Exports of members'
 * events"): the pipeline's `export-events` job reads the lake, the product folds the result in.
 */
const ExportRequestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const EXPORT_EVENTS_PREFIX = "privacy/export-events/";

export const PendingExportsQuery = z.object({
  limit: z.coerce.number<number>().int().min(1).max(500).optional(),
});
export type PendingExportsQuery = z.input<typeof PendingExportsQuery>;

/** Export requests whose events are not extracted yet, listed until a result is recorded. */
export const PendingExports = z
  .object({
    requests: z.array(
      z.object({
        requestId: ExportRequestId,
        /** The account's pseudonymous key, as the lake stores it. */
        accountKey: SubjectKey,
        /** The receipt window `[from, to)`. */
        from: IsoDateTime,
        to: IsoDateTime,
      }),
    ),
  })
  .meta({ id: "PendingExports" });
export type PendingExports = z.output<typeof PendingExports>;

/**
 * One request's result, as the job reports it. `file` and `manifest` can only name that
 * request's own documents under the job's private prefix: the product reads `file` and folds it
 * into the member's export, so the job cannot point it at any other document.
 */
const ExportEventsResult = z
  .object({
    requestId: ExportRequestId,
    status: z.enum(["complete", "erased", "deferred", "failed"]),
    from: IsoDateTime,
    to: IsoDateTime,
    events: z.number().int().nonnegative().optional(),
    file: z.string().max(200).optional(),
    manifest: z.string().max(200).optional(),
    bytes: z.number().int().nonnegative().optional(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    generatedAt: IsoDateTime.optional(),
    reused: z.boolean().optional(),
    notBefore: IsoDateTime.optional(),
    error: z.string().max(1000).optional(),
  })
  .superRefine((result, ctx) => {
    const own = `${EXPORT_EVENTS_PREFIX}${result.requestId}/`;
    if (result.file !== undefined && result.file !== `${own}events.ndjson.gz`) {
      ctx.addIssue({ code: "custom", path: ["file"], message: `Must be ${own}events.ndjson.gz` });
    }
    if (result.manifest !== undefined && result.manifest !== `${own}manifest.json`) {
      ctx.addIssue({ code: "custom", path: ["manifest"], message: `Must be ${own}manifest.json` });
    }
    if (
      result.status === "complete" &&
      (result.file === undefined || result.bytes === undefined || result.sha256 === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "A complete result names its file, bytes and sha256",
      });
    }
  });

/**
 * `export-events`'s results document (`webflix.export-events-results`, version 1) and the
 * `reason` the audit log keeps. It carries request ids, statuses and the job's private document
 * locations: never a download link.
 */
export const ExportResultsBody = z
  .object({
    format: z.literal("webflix.export-events-results"),
    formatVersion: z.literal(1),
    generatedAt: IsoDateTime,
    results: z.array(ExportEventsResult).max(500),
    reason: AuditReason,
  })
  .meta({ id: "ExportResultsBody" });
export type ExportResultsBody = z.input<typeof ExportResultsBody>;

// --- Billing actions --------------------------------------------------------------------------

export const RefundBody = z
  .object({
    invoiceId: Id,
    /** Omitted: refund what remains of the invoice. */
    amount: Money.optional(),
    reason: AuditReason,
    idempotencyKey: IdempotencyKey,
  })
  .meta({ id: "RefundBody" });
export type RefundBody = z.input<typeof RefundBody>;

export const Refund = z
  .object({
    id: Id,
    invoiceId: Id,
    amount: Money,
    status: z.enum(["pending", "succeeded", "failed"]),
    createdAt: IsoDateTime,
  })
  .meta({ id: "Refund" });
export type Refund = z.output<typeof Refund>;

export const CancelMemberSubscriptionBody = z
  .object({
    /** `now` ends it immediately; `period_end` lets it run out. */
    when: z.enum(["now", "period_end"]),
    /** With `now`: refund the unused time of the current period. */
    refundUnused: z.boolean().optional(),
    reason: AuditReason,
    idempotencyKey: IdempotencyKey,
  })
  .meta({ id: "CancelMemberSubscriptionBody" });
export type CancelMemberSubscriptionBody = z.input<typeof CancelMemberSubscriptionBody>;

export const ExtendTrialBody = z
  .object({
    days: z.number().int().min(1).max(30),
    reason: AuditReason,
    idempotencyKey: IdempotencyKey,
  })
  .meta({ id: "ExtendTrialBody" });
export type ExtendTrialBody = z.input<typeof ExtendTrialBody>;

export const ComplimentaryPeriodBody = z
  .object({
    days: z.number().int().min(1).max(366),
    reason: AuditReason,
    idempotencyKey: IdempotencyKey,
  })
  .meta({ id: "ComplimentaryPeriodBody" });
export type ComplimentaryPeriodBody = z.input<typeof ComplimentaryPeriodBody>;

// --- Plans and prices (§5.4) ------------------------------------------------------------------

export const PlanPrice = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    amountMinor: z.number().int().nonnegative(),
    /** The provider-side lookup key, e.g. `webflix.basic.monthly.usd`. */
    lookupKey: z.string(),
    active: z.boolean(),
    /** When this price was last synchronised to the configured provider; null: never. */
    syncedAt: IsoDateTime.nullable(),
  })
  .meta({ id: "PlanPrice" });

export const AdminPlan = z
  .object({
    id: PlanId,
    name: z.string(),
    maxStreams: z.number().int().positive(),
    maxQuality: z.enum(VIDEO_QUALITIES),
    trialDays: z.number().int().nonnegative(),
    prices: z.array(PlanPrice),
  })
  .meta({ id: "AdminPlan" });
export type AdminPlan = z.output<typeof AdminPlan>;

export const AdminPlanList = z.object({ items: z.array(AdminPlan) }).meta({ id: "AdminPlanList" });
export type AdminPlanList = z.output<typeof AdminPlanList>;

export const PlanPriceParams = z.object({
  planId: PlanId,
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const SetPlanPriceBody = z
  .object({ amountMinor: z.number().int().positive(), reason: AuditReason })
  .meta({ id: "SetPlanPriceBody" });
export type SetPlanPriceBody = z.input<typeof SetPlanPriceBody>;

export const PlanSyncResult = z
  .object({
    provider: z.string(),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    syncedAt: IsoDateTime,
  })
  .meta({ id: "PlanSyncResult" });
export type PlanSyncResult = z.output<typeof PlanSyncResult>;

// --- Editorial (§8.3) -------------------------------------------------------------------------

export const BillboardParams = z.object({ view: BrowseView });

/** Titles staff pin to a view's billboard, in order; empty: the engine chooses. */
export const EditorialBillboard = z
  .object({
    view: BrowseView,
    titleIds: z.array(Id),
    updatedAt: IsoDateTime.nullable(),
  })
  .meta({ id: "EditorialBillboard" });
export type EditorialBillboard = z.output<typeof EditorialBillboard>;

export const SetBillboardBody = z
  .object({ titleIds: z.array(Id).max(10), reason: AuditReason })
  .meta({ id: "SetBillboardBody" });
export type SetBillboardBody = z.input<typeof SetBillboardBody>;

const collectionFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).nullable(),
  view: BrowseView,
  /** Row position on the view (1-based) when published. */
  position: z.number().int().min(1).max(50),
  titleIds: z.array(Id).min(1).max(40),
  status: z.enum(["draft", "published"]),
};

export const EditorialCollection = z
  .object({ id: Id, ...collectionFields, updatedAt: IsoDateTime })
  .meta({ id: "EditorialCollection" });
export type EditorialCollection = z.output<typeof EditorialCollection>;

export const EditorialCollectionList = z
  .object({ items: z.array(EditorialCollection) })
  .meta({ id: "EditorialCollectionList" });
export type EditorialCollectionList = z.output<typeof EditorialCollectionList>;

export const CollectionBody = z
  .object({ ...collectionFields, reason: AuditReason })
  .meta({ id: "CollectionBody" });
export type CollectionBody = z.input<typeof CollectionBody>;

export const TitleIdParam = z.object({ titleId: Id });

/** A staff override of a title's availability; survives re-seeding the catalogue. */
export const TitleAvailability = z
  .object({
    titleId: Id,
    available: z.boolean(),
    availableFrom: IsoDateTime.nullable(),
    availableUntil: IsoDateTime.nullable(),
    updatedAt: IsoDateTime.nullable(),
  })
  .meta({ id: "TitleAvailability" });
export type TitleAvailability = z.output<typeof TitleAvailability>;

export const SetTitleAvailabilityBody = z
  .object({
    available: z.boolean(),
    availableFrom: IsoDateTime.nullable().optional(),
    availableUntil: IsoDateTime.nullable().optional(),
    reason: AuditReason,
  })
  .meta({ id: "SetTitleAvailabilityBody" });
export type SetTitleAvailabilityBody = z.input<typeof SetTitleAvailabilityBody>;

// --- Experiments (§8.1) -----------------------------------------------------------------------

/** A new experiment is a `draft`; its salt is generated. */
export const CreateExperimentBody = z
  .object({ ...experimentDefinitionFields, reason: AuditReason })
  .meta({ id: "CreateExperimentBody" });
export type CreateExperimentBody = z.input<typeof CreateExperimentBody>;

/** Only a `draft` may change its design; a running experiment may change its end date. */
export const UpdateExperimentBody = z
  .object(experimentDefinitionFields)
  .omit({ key: true })
  .partial()
  .extend({ reason: AuditReason })
  .meta({ id: "UpdateExperimentBody" });
export type UpdateExperimentBody = z.input<typeof UpdateExperimentBody>;

export const SetExperimentStatusBody = z
  .object({ status: z.enum(EXPERIMENT_STATUSES), reason: AuditReason })
  .meta({ id: "SetExperimentStatusBody" });
export type SetExperimentStatusBody = z.input<typeof SetExperimentStatusBody>;

// --- System (§8.3) ----------------------------------------------------------------------------

export const SystemHealth = z
  .object({
    dependencies: z.array(
      z.object({
        name: z.string(),
        up: z.boolean(),
        checkedAt: IsoDateTime.nullable(),
        detail: z.string().nullable(),
      }),
    ),
    jobs: z.object({
      /** Waiting jobs; null where the queue cannot report it (Cloudflare Queues). */
      depth: z.number().int().nonnegative().nullable(),
      deadLetters: z.number().int().nonnegative(),
    }),
    checkedAt: IsoDateTime,
  })
  .meta({ id: "SystemHealth" });
export type SystemHealth = z.output<typeof SystemHealth>;

export const DeadLetter = z
  .object({
    id: Id,
    jobType: z.string(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    failedAt: IsoDateTime,
    replayedAt: IsoDateTime.nullable(),
  })
  .meta({ id: "DeadLetter" });
export type DeadLetter = z.output<typeof DeadLetter>;

export const DeadLetterQuery = z.object({ ...AdminPageQuery });
export const DeadLetterPage = page(DeadLetter).meta({ id: "DeadLetterPage" });
export type DeadLetterPage = z.output<typeof DeadLetterPage>;

/** The served recommendation model (§7.2). */
export const RecommendationStatus = z
  .object({
    activeModel: z
      .object({
        run: z.string(),
        asOf: IsoDateTime,
        expiresAt: IsoDateTime,
        importedAt: IsoDateTime,
      })
      .nullable(),
    lastImport: z
      .object({
        run: z.string(),
        status: z.enum(["running", "succeeded", "failed"]),
        startedAt: IsoDateTime,
        finishedAt: IsoDateTime.nullable(),
        error: z.string().nullable(),
      })
      .nullable(),
  })
  .meta({ id: "RecommendationStatus" });
export type RecommendationStatus = z.output<typeof RecommendationStatus>;

// --- Audit log --------------------------------------------------------------------------------

export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES).meta({ id: "AuditOutcome" });

export const AuditQuery = z.object({
  actorId: z.string().min(1).max(255).optional(),
  targetType: z
    .string()
    .regex(/^[a-z][a-z_-]{0,31}$/)
    .optional(),
  targetId: z.string().min(1).max(255).optional(),
  /** E.g. `unknown` or `pending`: the actions someone must follow up. */
  outcome: AuditOutcomeSchema.optional(),
  ...AdminPageQuery,
});
export type AuditQuery = z.input<typeof AuditQuery>;

/**
 * One audit row as an area writes it in the same batch as its change (experiments,
 * personalisation). The log lists `AuditLogEntry`, which adds the outcome.
 */
export const AuditEntry = z
  .object({
    id: Id,
    actor: z.object({
      type: z.enum(AUDIT_ACTOR_TYPES),
      id: z.string(),
      name: z.string().nullable(),
    }),
    /** Dotted, e.g. `billing.refund`, `member.pin_removed`. */
    action: z.string(),
    target: z.object({ type: z.string(), id: z.string() }),
    before: JsonValue.nullable(),
    after: JsonValue.nullable(),
    reason: z.string().nullable(),
    requestId: z.string().nullable(),
    createdAt: IsoDateTime,
  })
  .meta({ id: "AuditEntry" });
export type AuditEntry = z.output<typeof AuditEntry>;

/**
 * An entry of the audit log. Actions of the identity, billing and events areas and the system
 * actions are written before they run (`pending`) and settled after (`completedAt`); a row an
 * area wrote in the same batch as its change is `succeeded` from the start (`completedAt` null).
 * Reading a member's record is audited too (`member.viewed`, `member.searched`,
 * `member.privacy_viewed`: no reason, `succeeded`).
 */
export const AuditLogEntry = AuditEntry.extend({
  outcome: AuditOutcomeSchema,
  completedAt: IsoDateTime.nullable(),
}).meta({ id: "AuditLogEntry" });
export type AuditLogEntry = z.output<typeof AuditLogEntry>;

export const AuditPage = page(AuditLogEntry).meta({ id: "AuditPage" });
export type AuditPage = z.output<typeof AuditPage>;
