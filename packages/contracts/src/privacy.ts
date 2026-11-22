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
  })
  .meta({ id: "PrivacyRequest" });
export type PrivacyRequest = z.output<typeof PrivacyRequest>;

export const PrivacyRequestList = z
  .object({ items: z.array(PrivacyRequest) })
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
 * holds each milestone 2 area's own part (identities, invoices...) under the area's name;
 * `notes` says what is held elsewhere (the payment provider) and why something is not included.
 */
export const DataExport = z
  .object({
    format: z.literal("webflix.data-export"),
    formatVersion: z.literal(1),
    requestId: Id,
    generatedAt: IsoDateTime,
    account: z.object({ id: Id, email: z.string(), createdAt: IsoDateTime }),
    membership: z
      .object({
        planId: z.string(),
        startedAt: IsoDateTime,
        currentPeriodEnd: IsoDateTime,
        canceledAt: ExportTime,
        card: z
          .object({
            brand: z.string(),
            last4: z.string(),
            expMonth: z.number().int(),
            expYear: z.number().int(),
          })
          .nullable(),
      })
      .nullable(),
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
