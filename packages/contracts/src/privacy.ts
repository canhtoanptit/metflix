/**
 * Milestone 2 privacy (docs/BLUEPRINT-M2.md §6.3): consent, data export and account deletion.
 */
import * as z from "zod";
import { Id, IsoDateTime, ResourceUrl } from "./common.ts";
import {
  CONSENT_MODES,
  CONSENT_PURPOSES,
  CONSENT_SOURCES,
  PRIVACY_REQUEST_KINDS,
  PRIVACY_REQUEST_STATUSES,
} from "./constants.ts";
import { LakeEvent } from "./events.ts";

export const ConsentPurpose = z.enum(CONSENT_PURPOSES).meta({ id: "ConsentPurpose" });
export type ConsentPurpose = z.output<typeof ConsentPurpose>;

export const ConsentPurposeState = z
  .object({
    granted: z.boolean(),
    /** How the current answer was given; null when it is the mode's default. */
    source: z.enum(CONSENT_SOURCES).nullable(),
    updatedAt: IsoDateTime.nullable(),
  })
  .meta({ id: "ConsentPurposeState" });

/**
 * The consent in force for the caller: the account's latest answer per purpose (the latest stamp
 * wins), or the deployment mode's default. `gpc`: the request carried Global Privacy Control,
 * which is honoured as a withdrawal.
 */
export const ConsentState = z
  .object({
    mode: z.enum(CONSENT_MODES),
    gpc: z.boolean(),
    /** Whether the web must ask (opt-in mode and no answer yet). */
    promptRequired: z.boolean(),
    purposes: z.object({
      analytics: ConsentPurposeState,
      personalisation: ConsentPurposeState,
    }),
  })
  .meta({ id: "ConsentState" });
export type ConsentState = z.output<typeof ConsentState>;

export const UpdateConsentBody = z
  .object({
    purpose: ConsentPurpose,
    granted: z.boolean(),
    /** `gpc` is detected by the server and `support` is a staff action; neither is sent here. */
    source: z.enum(["banner", "settings"]),
  })
  .meta({ id: "UpdateConsentBody" });
export type UpdateConsentBody = z.input<typeof UpdateConsentBody>;

/**
 * What an account deletion did to the membership (§6.3). Asking for a deletion stops the
 * renewals at once (through billing): the membership ends at the close of its current period,
 * or with the account if the erasure comes first, and nothing more is charged.
 *
 * - `stopping`: billing has not confirmed yet (the provider was unavailable); retried on every
 *   scheduler tick until it does. The erasure ends the membership in any case.
 * - `ending`: set to end at `endsAt`; nothing more is charged.
 * - `renewing`: it renews as usual again. Once the account is kept: the member resumed it, or
 *   kept the account before the renewals were stopped. While the deletion is scheduled the
 *   member cannot cause it (billing refuses resume, a checkout and a plan change with
 *   `account_deletion_scheduled`); only staff (a complimentary period, a trial extension) or
 *   the provider can.
 * - `ended`: it has ended.
 * - `none`: the account had no membership a payment provider renews (none, already ended, or
 *   milestone 1's mock membership, which charges nothing).
 */
export const DeletionMembership = z
  .object({
    status: z.enum(["stopping", "ending", "renewing", "ended", "none"]),
    /**
     * `ending` only: when the membership ends. While the deletion is `scheduled`, the earlier of
     * the period's close and `scheduledFor` (the erasure ends it); once the deletion is
     * `canceled`, the period's close.
     */
    endsAt: IsoDateTime.nullable(),
    /**
     * The member kept the account (the deletion is `canceled`) and the membership is still set
     * to end: offer one action to resume it (`POST /account/subscription/resume`).
     */
    resumable: z.boolean(),
  })
  .meta({ id: "DeletionMembership" });
export type DeletionMembership = z.output<typeof DeletionMembership>;

/**
 * An export ("Download your data": asynchronous, a signed link by email) or a deletion
 * (cooling-off period, then erasure; billing records retained as the law requires).
 */
export const PrivacyRequest = z
  .object({
    id: Id,
    kind: z.enum(PRIVACY_REQUEST_KINDS),
    status: z.enum(PRIVACY_REQUEST_STATUSES),
    requestedAt: IsoDateTime,
    /** Deletion: when the cooling-off period ends and erasure starts. */
    scheduledFor: IsoDateTime.nullable(),
    completedAt: IsoDateTime.nullable(),
    /** Export: the signed download link, once ready and until `expiresAt`. */
    downloadUrl: ResourceUrl.nullable(),
    expiresAt: IsoDateTime.nullable(),
    /**
     * Deletion: what it did to the membership. Null for an export, and for a deletion recorded
     * before deletions stopped renewals.
     */
    membership: DeletionMembership.nullable(),
  })
  .meta({ id: "PrivacyRequest" });
export type PrivacyRequest = z.output<typeof PrivacyRequest>;

/**
 * What a member is entitled to know before asking for an export or a deletion: this
 * deployment's settings (configuration only: serving them reads no database).
 */
export const PrivacyTerms = z
  .object({
    /** A deletion waits this long (cancellable meanwhile) before the account is erased. */
    deletionCoolingOffSec: z.number().int().positive(),
    /** How long an export's link (and the export itself) stays available once it is ready. */
    exportLinkTtlSec: z.number().int().positive(),
    /**
     * Who reads an export's behaviour events: `inline`, the export job itself (ready within
     * seconds); `batch`, the pipeline's scheduled job (many minutes).
     */
    exportMode: z.enum(["inline", "batch"]),
    /** How long an export normally takes here, from the request to the email. */
    exportTypicalSec: z.number().int().positive(),
    /** How far back behaviour events are kept, and so how far back an export reaches. */
    eventsRetentionDays: z.number().int().positive(),
    /** How long aggregated statistics derived from them are kept. */
    aggregatesRetentionDays: z.number().int().positive(),
  })
  .meta({ id: "PrivacyTerms" });
export type PrivacyTerms = z.output<typeof PrivacyTerms>;

export const PrivacyRequestList = z
  .object({
    items: z.array(PrivacyRequest),
    /** The terms that apply to a new request (served with the list, from configuration). */
    terms: PrivacyTerms,
  })
  .meta({ id: "PrivacyRequestList" });
export type PrivacyRequestList = z.output<typeof PrivacyRequestList>;

/** `GET /privacy/exports/:id?token=`: the signed download link of a completed export. */
export const DataExportParams = z.object({ id: Id });
export const DataExportQuery = z.object({ token: z.string().min(1).max(4096) });
export type DataExportQuery = z.input<typeof DataExportQuery>;

const ExportTime = IsoDateTime.nullable();

/**
 * "Download your data" (§6.3): everything Webflix holds about the account, as one document.
 * `events` are the account's behaviour events in the lake (pseudonymous, as stored); `areas`
 * holds each area's own part under the area's name (`identity`: sign-in methods and email
 * verification; `billing`: membership and invoices; ...);
 * `notes` says what is held elsewhere (the payment provider) and why something is not included.
 */
export const DataExport = z
  .object({
    format: z.literal("webflix.data-export"),
    formatVersion: z.literal(1),
    requestId: Id,
    generatedAt: IsoDateTime,
    account: z.object({ id: Id, email: z.string(), createdAt: IsoDateTime }),
    profiles: z.array(
      z.object({
        id: Id,
        name: z.string(),
        avatarId: z.string(),
        kids: z.boolean(),
        maturityCeiling: z.string(),
        locked: z.boolean(),
        settings: z.record(z.string(), z.unknown()),
        createdAt: IsoDateTime,
      }),
    ),
    devices: z.array(
      z.object({
        id: Id,
        label: z.string(),
        type: z.string(),
        signedInAt: IsoDateTime,
        lastSeenAt: IsoDateTime,
        expiresAt: IsoDateTime,
      }),
    ),
    library: z.array(
      z.object({
        profileId: Id,
        myList: z.array(z.object({ titleId: z.string(), addedAt: IsoDateTime })),
        ratings: z.array(
          z.object({ titleId: z.string(), value: z.string(), ratedAt: IsoDateTime }),
        ),
        progress: z.array(
          z.object({
            titleId: z.string(),
            episodeId: z.string().nullable(),
            positionSec: z.number(),
            durationSec: z.number(),
            completed: z.boolean(),
            updatedAt: IsoDateTime,
          }),
        ),
        history: z.array(
          z.object({
            titleId: z.string(),
            episodeId: z.string().nullable(),
            watchedAt: IsoDateTime,
          }),
        ),
      }),
    ),
    consents: z.array(
      z.object({
        purpose: ConsentPurpose,
        granted: z.boolean(),
        source: z.enum(CONSENT_SOURCES),
        at: IsoDateTime,
      }),
    ),
    privacyRequests: z.array(
      z.object({
        id: Id,
        kind: z.enum(PRIVACY_REQUEST_KINDS),
        status: z.enum(PRIVACY_REQUEST_STATUSES),
        requestedAt: IsoDateTime,
        completedAt: ExportTime,
      }),
    ),
    events: z.array(LakeEvent),
    areas: z.record(z.string(), z.unknown()),
    notes: z.array(z.string()),
  })
  .meta({ id: "DataExport" });
export type DataExport = z.output<typeof DataExport>;
