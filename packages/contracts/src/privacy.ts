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
