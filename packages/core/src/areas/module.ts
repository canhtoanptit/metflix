import type {
  EventContext,
  EventPayload,
  ExperimentAssignments,
  JsonValue,
  ServerEventType,
} from "@webflix/contracts";
import type {
  AssignmentContext,
  ExperimentUnit,
  LazyAssignmentContext,
} from "../ports/experiments.ts";
import type { JobBinding, JobMessage } from "../ports/job-queue.ts";
import type { EmailRequest } from "./identity/email.ts";

/**
 * What every milestone 2 area service offers the composition, so an area adds jobs and periodic
 * work in its own files: the processor and the scheduler (services/jobs.ts) compose them.
 */
export interface AreaModule {
  /** Handlers for this area's job types (webhook processing, email sending, imports...). */
  readonly jobs: readonly JobBinding[];
  /** Idempotent jobs to publish on every scheduler tick (reconciliation, compaction...). */
  scheduled(now: number): readonly JobMessage[];
  /**
   * Privacy (§6.3, "Download your data"): this area's part of a member's data export, as JSON,
   * under the area's name. Optional: the events area's export job asks every area that has one.
   */
  exportAccountData?(accountId: string): Promise<JsonValue>;
  /**
   * Privacy (§6.3, "Delete account"): erase what this area holds about an account that is
   * being deleted and that the account row's foreign keys do not cascade to (provider-side
   * objects, key-value entries...), keeping what the law requires. Called by the erasure job
   * before the account row is deleted; idempotent (the job may run it again).
   */
  eraseAccountData?(accountId: string): Promise<void>;
}

/** An area with no jobs yet. */
export const NO_JOBS: Pick<AreaModule, "jobs" | "scheduled"> = {
  jobs: [],
  scheduled: () => [],
};

/**
 * A server event as a service hands it over (milestone 2 §6.1). The events area stamps the
 * envelope (`eventId`, `receivedAt`, `source`, `app`) and the subject (pseudonymous keys, plan,
 * country, restricted, consent) from these ids, and drops what consent or a restricted profile
 * rules out.
 */
export interface ServerEventInput<T extends ServerEventType = ServerEventType> {
  type: T;
  payload: EventPayload<T>;
  accountId: string | null;
  /** Null for events before a profile is chosen (sign-in, sign-up, billing, consent). */
  profileId: string | null;
  deviceId?: string | null;
  context?: Partial<EventContext>;
  /** Epoch ms; default now. */
  occurredAt?: number;
  /**
   * A UUIDv7 the producer derived itself, so the same occurrence emitted twice is one event to
   * the lake's readers (they deduplicate by `eventId`). Default: a fresh one.
   */
  eventId?: string;
}

/**
 * Cross-area seams: what one area offers the others, built once by `createServices` and
 * passed to every area service, so no area imports another area's internals.
 */
export interface AreaSeams {
  /**
   * Events area: emit a server event (playback, billing transitions, sign-in and sign-up
   * outcomes, experiment exposure, consent changes). Never throws for a delivery problem: a
   * lost behaviour event must not fail a member's request.
   */
  emitServerEvent(event: ServerEventInput): Promise<void>;
  /**
   * Events area: a profile became restricted (kids, or a lowered ceiling): it emits nothing from
   * now on, and its earlier behaviour must leave the training data. Queues that profile's
   * pseudonymous key for the pipeline's erase job (which removes its history from the lake,
   * datasets and recommendation artefacts). Only that profile, never the account's others;
   * safe to call twice. Throws only when the record cannot be written.
   */
  forgetProfileBehaviour(input: { accountId: string; profileId: string }): Promise<void>;
  /**
   * Events area: whether the account's deletion is scheduled (its cooling-off period is
   * running). Billing refuses whatever would make the membership renew again meanwhile
   * (`account_deletion_scheduled`). One read of the account's privacy requests.
   */
  accountDeletionScheduled(accountId: string): Promise<boolean>;
  /**
   * Experiments area: a unit's assignments (key → variant), e.g. the ranking policy a profile's
   * browse page uses. Logging the exposure is the caller's, when the treatment is experienced.
   */
  assignments(
    unit: ExperimentUnit,
    context: AssignmentContext | LazyAssignmentContext,
  ): Promise<ExperimentAssignments>;
  /**
   * Experiments area: log that a unit experienced its variant of an experiment (an
   * `experiment.exposure` server event, once per unit and variant). Never throws.
   */
  logExposure(exposure: {
    experimentKey: string;
    variant: string;
    unit: ExperimentUnit;
    accountId: string | null;
    profileId: string | null;
    context?: Partial<EventContext>;
  }): Promise<void>;
  /**
   * Identity area (email, §8.2): queue a templated email (`packages/email`'s templates: receipt,
   * payment failed, trial ending, plan changed, cancellation, data export ready...). Sent as a
   * job, at most once per `idempotencyKey`, never to a suppressed address. Throws only when the
   * job cannot be queued.
   */
  sendEmail(request: EmailRequest): Promise<void>;
}
