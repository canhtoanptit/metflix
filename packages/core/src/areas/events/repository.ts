import type {
  CONSENT_PURPOSES,
  CONSENT_SOURCES,
  PRIVACY_REQUEST_KINDS,
  PRIVACY_REQUEST_STATUSES,
} from "@webflix/contracts";
import type { OutboxEvent } from "../../repositories/ports.ts";
import type { PlaybackSessionRecord } from "../../repositories/records.ts";

/**
 * Repository port of the events area: `consents`, `privacy_requests`, `privacy_erasures`
 * (migrations under `packages/db/src/migrations/events/`). The events themselves live in the
 * event lake (`EventSink`), never in the database.
 *
 * Implemented in memory by `packages/core/src/memory/areas/events.ts` and on every dialect by
 * `packages/db/src/repositories/areas/events.ts`; both pass `describeEventsRepositoryContract`
 * (`packages/core/src/testing/areas/events.contract.ts`). The D1 rules hold: one method per
 * atomic write (one batch), at most 100 bound parameters per statement, hot reads in one round
 * trip (ingestion reads consent once per batch, never per event).
 */
export interface EventsRepository {
  /** Append one consent answer; the history is kept (the latest stamp wins on read). */
  addConsent(record: ConsentRecord): Promise<void>;
  /**
   * The answer in force per purpose at `at` (epoch ms): the latest given at or before it, a tie
   * going to the later id. At most one record per purpose; one round trip.
   */
  consentsAt(accountId: string, at: number): Promise<ConsentRecord[]>;
  /** Every answer of the account, oldest first (data export). */
  listConsents(accountId: string): Promise<ConsentRecord[]>;

  /**
   * Insert a privacy request unless the account already has an open one (`pending`,
   * `scheduled`, `processing`) of the same kind. Atomic; false when one is open.
   */
  createPrivacyRequest(record: PrivacyRequestRecord): Promise<boolean>;
  getPrivacyRequest(id: string): Promise<PrivacyRequestRecord | null>;
  /** The account's requests, newest first. */
  listPrivacyRequests(accountId: string): Promise<PrivacyRequestRecord[]>;
  /**
   * Compare-and-set: apply `patch` only while the request's status is one of `from`. False
   * when it was not (another worker moved it, the member cancelled it). The job steps rely on
   * it to stay idempotent under at-least-once delivery.
   */
  transitionPrivacyRequest(
    id: string,
    from: readonly PrivacyRequestStatus[],
    patch: PrivacyRequestPatch,
  ): Promise<boolean>;
  /** `scheduled` deletions whose cooling-off ended at or before `now`, oldest first. */
  dueDeletions(now: number, limit: number): Promise<PrivacyRequestRecord[]>;
  /** Exports whose link expired before `now` and that still name a document, oldest first. */
  expiredExports(now: number, limit: number): Promise<PrivacyRequestRecord[]>;
  /**
   * Exports assembled in batch mode and waiting for their events from the pipeline
   * (`processing`, holding their partial document `privacy/exports/{id}.partial.json.gz`),
   * oldest request first, at most `limit`.
   */
  waitingExports(limit: number): Promise<PrivacyRequestRecord[]>;
  /**
   * Exports whose job may be lost: `pending` or `processing` without a document, not updated
   * since `before`, least recently updated first, at most `limit`.
   */
  staleExports(before: number, limit: number): Promise<PrivacyRequestRecord[]>;
  /**
   * `scheduled` deletions whose membership renewals are still being stopped
   * (`membershipStep: "stopping"`): billing has not confirmed yet. Least recently updated first
   * (every attempt touches `updatedAt`, so each gets its turn), at most `limit`.
   */
  deletionsStoppingMembership(limit: number): Promise<PrivacyRequestRecord[]>;

  /**
   * Subject keys whose lake events the pipeline's erase job drops. Idempotent: a pending
   * record is kept as it was; a confirmed one asked for again is pending again (a profile that
   * became restricted a second time has new history to erase).
   */
  addErasures(records: readonly PrivacyErasureRecord[]): Promise<void>;
  /**
   * The erasures the operator must run, oldest first, at most `limit`: pending records listed
   * on their own (accounts, and profiles erased alone). A profile record of an account
   * deletion (`accountKey` set) is never listed: the account's key covers it.
   */
  pendingErasures(limit: number): Promise<PrivacyErasureRecord[]>;
  /**
   * The erase job removed these keys' events (idempotent): their records, and the profile
   * records of the accounts among them, are settled.
   */
  markErasuresCompacted(subjectKeys: readonly string[], at: number): Promise<void>;

  /**
   * Playback sessions still open whose credit clock (`lastHeartbeatAt`, within a few seconds of
   * the last report) is before `cutoff`: candidates for the expiry sweep, oldest first.
   */
  openPlaybackBefore(cutoff: number, limit: number): Promise<PlaybackSessionRecord[]>;

  /** Outbox rows (written by the playback repository), oldest first, at most `limit`. */
  takeOutbox(limit: number): Promise<OutboxEvent[]>;
  /** Drained rows (idempotent). */
  deleteOutbox(ids: readonly string[]): Promise<void>;

  /**
   * Erasure (§6.3): delete the account row. The schema's foreign keys cascade to everything
   * that must go (sessions, profiles and their list, ratings, progress and history,
   * subscriptions, consents, linked identities, tokens), and nothing the law requires to be kept
   * references accounts (billing records, privacy requests: D-M2-6). False when it was gone.
   * The accounts table is the identity area's; this is the one write the events area makes to
   * it, because erasure is this area's job and the cascade is the schema's. The account's rows
   * still waiting in the event outbox go in the same batch.
   */
  deleteAccount(accountId: string): Promise<boolean>;
}

export type ConsentPurposeName = (typeof CONSENT_PURPOSES)[number];
export type ConsentSourceName = (typeof CONSENT_SOURCES)[number];
export type PrivacyRequestKind = (typeof PRIVACY_REQUEST_KINDS)[number];
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];

export interface ConsentRecord {
  /** UUIDv7: orders answers given within the same millisecond. */
  id: string;
  accountId: string;
  purpose: ConsentPurposeName;
  granted: boolean;
  source: ConsentSourceName;
  /** Epoch ms. */
  createdAt: number;
}

export interface PrivacyRequestRecord {
  id: string;
  accountId: string;
  kind: PrivacyRequestKind;
  status: PrivacyRequestStatus;
  requestedAt: number;
  /** Deletion: end of the cooling-off period. */
  scheduledFor: number | null;
  completedAt: number | null;
  /** Export: the private document holding it (`privacy/exports/…`). */
  exportBlobKey: string | null;
  /** Export: when its link and document expire. */
  expiresAt: number | null;
  lastError: string | null;
  updatedAt: number;
  /**
   * Deletion: what it did to the membership. `stopping` until billing confirms the renewals
   * stopped (retried by the sweep), then `ending` (it ends at `membershipEndsAt`) or `none` (no
   * membership a provider renews). Null on exports and on deletions recorded before.
   */
  membershipStep: MembershipStep | null;
  /** Deletion, `ending`: when the membership ends (its period's close, as billing reported). */
  membershipEndsAt: number | null;
}

export const MEMBERSHIP_STEPS = ["stopping", "ending", "none"] as const;
export type MembershipStep = (typeof MEMBERSHIP_STEPS)[number];

export type PrivacyRequestPatch = Partial<
  Pick<
    PrivacyRequestRecord,
    | "status"
    | "scheduledFor"
    | "completedAt"
    | "exportBlobKey"
    | "expiresAt"
    | "lastError"
    | "membershipStep"
    | "membershipEndsAt"
  >
> & { updatedAt: number };

export interface PrivacyErasureRecord {
  subjectKey: string;
  kind: "account" | "profile";
  /** The account erasure this profile record belongs to; null for one listed on its own. */
  accountKey: string | null;
  requestedAt: number;
  compactedAt: number | null;
}

/** The suffix of an export's partial document while it waits for its events (batch mode). */
export const PARTIAL_EXPORT_SUFFIX = ".partial.json.gz";

/** Statuses of a request still in progress (one per kind and account at a time). */
export const OPEN_PRIVACY_STATUSES = [
  "pending",
  "scheduled",
  "processing",
] as const satisfies readonly PrivacyRequestStatus[];
