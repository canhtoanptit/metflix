import type {
  EventContext,
  EventPayload,
  ExperimentAssignments,
  ServerEventType,
} from "@webflix/contracts";
import type { AssignmentContext, ExperimentUnit } from "../ports/experiments.ts";
import type { JobBinding, JobMessage } from "../ports/job-queue.ts";

/**
 * What every milestone 2 area service offers the composition, so an area adds jobs and periodic
 * work in its own files: the processor and the scheduler (services/jobs.ts) compose them.
 */
export interface AreaModule {
  /** Handlers for this area's job types (webhook processing, email sending, imports...). */
  readonly jobs: readonly JobBinding[];
  /** Idempotent jobs to publish on every scheduler tick (reconciliation, compaction...). */
  scheduled(now: number): readonly JobMessage[];
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
   * Experiments area: a unit's assignments (key → variant), e.g. the ranking policy a profile's
   * browse page uses. Logging the exposure is the caller's, when the treatment is experienced.
   */
  assignments(unit: ExperimentUnit, context: AssignmentContext): Promise<ExperimentAssignments>;
}
