import {
  EVENT_BATCH_MAX_EVENTS,
  EventContext,
  EventId,
  EventOpaqueId,
  EventTimestamp,
  SERVER_EVENT_TYPES,
} from "@webflix/contracts";
import * as z from "zod";
import { defineJob } from "../../ports/job-queue.ts";

/**
 * Append stamped events to the lake (the consumer of `POST /events`). The events are
 * `LakeEvent`s already; the handler validates each again before it writes.
 */
export const appendEventsJob = defineJob(
  "events.append",
  z.object({ events: z.array(z.unknown()).min(1).max(EVENT_BATCH_MAX_EVENTS) }),
);

/**
 * A server event handed over by a service through the `emitServerEvent` seam: its envelope
 * (id, times, context, payload) and the internal ids the consumer stamps the subject from, off
 * the member's request path.
 */
export const serverEventJob = defineJob(
  "events.server",
  z.object({
    event: z.object({
      eventId: EventId,
      type: z.enum(SERVER_EVENT_TYPES),
      occurredAt: EventTimestamp,
      receivedAt: EventTimestamp,
      deviceId: EventOpaqueId.nullable(),
      context: EventContext,
      payload: z.record(z.string(), z.unknown()),
    }),
    accountId: z.string().min(1).max(64).nullable(),
    profileId: z.string().min(1).max(64).nullable(),
  }),
);

/** Build one data export ("Download your data"). */
export const privacyExportJob = defineJob(
  "privacy.export",
  z.object({ requestId: z.string().min(1).max(64) }),
);

/** Erase one account whose deletion's cooling-off period ended. */
export const privacyEraseJob = defineJob(
  "privacy.erase",
  z.object({ requestId: z.string().min(1).max(64) }),
);

/** Each scheduler tick: start due erasures, delete expired exports. */
export const privacySweepJob = defineJob("privacy.sweep", z.object({}));

/**
 * Drain the event outbox (playback's server events, written with the playback writes) to the
 * lake. Published on every scheduler tick; idempotent (rows are deleted once stored).
 */
export const drainOutboxJob = defineJob("events.outbox", z.object({}));
