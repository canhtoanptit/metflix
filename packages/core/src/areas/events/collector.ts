import {
  type ClientEventInput,
  EVENT_VERSION,
  type EventBatchAck,
  type EventContext,
  type EventSubject,
  LakeEvent,
  type PlanId,
  PROFILELESS_EVENT_TYPES,
} from "@webflix/contracts";
import { utf8ByteLength } from "../../encoding.ts";
import { AppError } from "../../errors.ts";
import { toIsoString } from "../../ports/clock.ts";
import type { SubjectKeys } from "../../ports/event-sink.ts";
import { MAX_JOB_PAYLOAD_BYTES } from "../../ports/job-queue.ts";
import { serializeError } from "../../ports/logger.ts";
import type { OutboxEvent } from "../../repositories/ports.ts";
import type { AuthContext, ServiceDependencies } from "../../services/context.ts";
import { standingOf } from "../../services/privileges.ts";
import type { ServerEventInput } from "../module.ts";
import { anyConsent, type ConsentFlags, deviceConsent, effectiveConsent } from "./consent.ts";
import { appendEventsJob, serverEventJob } from "./jobs.ts";
import type { ConsentLedger } from "./ledger.ts";
import type { OtherAreas } from "./neighbours.ts";

/** What the HTTP layer knows about an ingestion request beyond the session. */
export interface IngestRequest {
  auth: AuthContext | null;
  events: readonly ClientEventInput[];
  /** A signed-out device's own answer (opt-in mode); ignored for a signed-in session. */
  consent?: ConsentFlags | undefined;
  /** The request carried `Sec-GPC: 1`. */
  gpc: boolean;
  /** ISO 3166 alpha-2 from the platform (Workers' `request.cf.country`), else null. */
  country: string | null;
}

const EMPTY_CONTEXT: EventContext = {
  surface: null,
  rowId: null,
  rowRank: null,
  rank: null,
  experiments: {},
  policy: null,
};

/** Restricted standing (kids, lowered ceiling): never profiled, by any path (§6.3). */
export function isRestrictedProfile(profile: Parameters<typeof standingOf>[0]): boolean {
  const standing = standingOf(profile);
  return standing === "kids" || standing === "restricted";
}

/**
 * A server event's job payload (`events.server`): the envelope the producer knows, and the
 * internal ids the consumer stamps the subject from. Validated: throws on a malformed event.
 */
export function serverEventJobFor(input: ServerEventInput, now: number, eventId: string) {
  return serverEventJob.create({
    event: {
      eventId,
      type: input.type,
      occurredAt: toIsoString(input.occurredAt ?? now),
      receivedAt: toIsoString(now),
      deviceId: input.deviceId ?? null,
      context: { ...EMPTY_CONTEXT, ...input.context },
      payload: input.payload as Record<string, unknown>,
    },
    accountId: input.accountId,
    profileId: input.profileId,
  });
}

/**
 * A server event as an event-outbox row, for producers that write it in the same batch as
 * their own write (playback): the events area's `events.outbox` job drains it to the lake.
 * The producer supplies the id (`input.eventId`), so a retried write is the same event.
 */
export function toOutboxEvent(
  input: ServerEventInput & { eventId: string },
  now: number,
): OutboxEvent {
  const job = serverEventJobFor(input, now, input.eventId);
  return {
    id: input.eventId,
    accountId: input.accountId,
    profileId: input.profileId,
    payload: JSON.stringify(job.payload),
    createdAt: now,
  };
}

/**
 * Behaviour collection (§6.1, §6.2): client batches validated by the route, server events from
 * the seam; both stamped with who and under what consent, then queued; the consumer writes
 * the lake. Privacy rules applied here, in one place for both paths:
 * - a restricted profile's events are dropped, client and server alike;
 * - events without any consented purpose are dropped (`consent.change` excepted: it is the
 *   withdrawal itself); `off` mode collects nothing;
 * - the subject is always the server's (the contract refuses client-supplied identities).
 */
export function createCollector(
  deps: ServiceDependencies,
  keys: SubjectKeys,
  ledger: ConsentLedger,
  otherAreas: OtherAreas,
) {
  const { clock, ids, jobs, logger, config, repos, eventSink } = deps;
  const mode = () => config.events.consentMode;

  /** The plan the member may play on now (billing decides); null without an entitled membership. */
  const planOf = (accountId: string) => otherAreas().billing.currentPlan(accountId);

  /** The plan, or `gone` when billing no longer knows the account (erased since). */
  async function planOrGone(accountId: string): Promise<{ plan: PlanId | null } | "gone"> {
    try {
      return { plan: await planOf(accountId) };
    } catch (error) {
      if (error instanceof AppError && error.code === "unauthenticated") return "gone";
      throw error;
    }
  }

  async function subjectOf(input: {
    accountId: string | null;
    profileId: string | null;
    plan: PlanId | null;
    country: string | null;
    consent: ConsentFlags;
  }): Promise<EventSubject> {
    return {
      account: input.accountId ? await keys.account(input.accountId) : null,
      profile: input.profileId ? await keys.profile(input.profileId) : null,
      plan: input.plan,
      country: input.country,
      // Restricted subjects never reach here (dropped above): the flag stays for the readers.
      restricted: false,
      consent: {
        analytics: input.consent.analytics,
        personalisation: input.consent.personalisation,
      },
    };
  }

  /**
   * Publish stamped events for the consumer: one job per batch, split in halves while one would
   * exceed the queue's 128 KiB (50 events of 64 KiB plus subjects stay well under it).
   */
  async function publishAppend(events: LakeEvent[]): Promise<void> {
    const job = appendEventsJob.create({ events });
    if (events.length > 1 && utf8ByteLength(JSON.stringify(job)) > MAX_JOB_PAYLOAD_BYTES - 1024) {
      const middle = Math.ceil(events.length / 2);
      await publishAppend(events.slice(0, middle));
      await publishAppend(events.slice(middle));
      return;
    }
    await jobs.publish(job);
  }

  /** `POST /events`: validate the batch's shape beyond the schema, stamp, queue. */
  async function ingest(request: IngestRequest): Promise<EventBatchAck> {
    const total = request.events.length;
    const devices = new Set(request.events.map((event) => event.deviceId));
    if (devices.size > 1) {
      throw new AppError("validation_failed", {
        issues: [
          {
            location: "body",
            path: "events",
            message: "A batch carries the events of one device",
            code: "custom",
          },
        ],
      });
    }
    const dropAll: EventBatchAck = { accepted: 0, dropped: total };
    if (mode() === "off") return dropAll;
    const auth = request.auth;
    // A kids or restricted profile produces no behavioural events: nothing is even read.
    if (auth?.profile && isRestrictedProfile(auth.profile)) return dropAll;
    const now = clock.now();
    let consent: ConsentFlags;
    let plan: PlanId | null = null;
    if (auth) {
      // Once per batch (never per event), in parallel: consent and the plan.
      const [inForce, current] = await Promise.all([
        ledger.inForce(auth.session.accountId, now, { gpc: request.gpc }),
        planOf(auth.session.accountId),
      ]);
      consent = inForce;
      plan = current;
    } else {
      consent = deviceConsent(mode(), request.consent, request.gpc);
    }
    if (!anyConsent(consent)) return dropAll;

    const receivedAt = toIsoString(now);
    const subject = await subjectOf({
      accountId: auth?.session.accountId ?? null,
      profileId: auth?.profile?.id ?? null,
      plan,
      country: request.country,
      consent,
    });
    const stamped = request.events.map(
      (event) =>
        ({
          eventId: event.eventId,
          type: event.type,
          version: event.version,
          source: "client",
          occurredAt: event.occurredAt,
          receivedAt,
          deviceId: event.deviceId,
          sessionSeq: event.sessionSeq,
          app: { platform: event.app.platform, version: event.app.version },
          // Positions, experiments and the ranking policy travel exactly as the client sent
          // them (the ranker's position-bias correction depends on rowRank and rank).
          context: structuredClone(event.context),
          subject,
          payload: structuredClone(event.payload),
        }) as LakeEvent,
    );
    try {
      await publishAppend(stamped);
    } catch (error) {
      logger.error("events.enqueue_failed", { events: total, error: serializeError(error) });
      // The SDK keeps the batch and retries: nothing is lost silently.
      throw new AppError("service_unavailable", { detail: "Events could not be queued; retry" });
    }
    return { accepted: total, dropped: 0 };
  }

  /** The `emitServerEvent` seam: stamp the envelope, queue it. Never throws. */
  async function emitServerEvent(input: ServerEventInput): Promise<void> {
    try {
      await jobs.publish(serverEventJobFor(input, clock.now(), input.eventId ?? ids.next()));
    } catch (error) {
      // A lost behaviour event must never fail the member's request.
      logger.warn("events.server_event_failed", {
        type: input.type,
        error: serializeError(error),
      });
    }
  }

  /** Why a server event is not stored, or null when it is. */
  type SkipReason = "account_gone" | "profile_gone" | "restricted" | "no_consent" | "invalid";

  /**
   * The consumer of `events.server`: stamp the subject as of receipt (consent in force at
   * `receivedAt`, the profile's standing, the plan), apply the privacy rules, validate.
   */
  async function stampServerEvent(
    payload: ReturnType<typeof serverEventJob.schema.parse>,
  ): Promise<{ event: LakeEvent } | { skipped: SkipReason }> {
    const { event, accountId } = payload;
    if (mode() === "off") return { skipped: "no_consent" };
    const profileless = (PROFILELESS_EVENT_TYPES as readonly string[]).includes(event.type);
    const profileId = profileless ? null : payload.profileId;
    const receivedAt = Date.parse(event.receivedAt);
    const [membership, profile, latest] = await Promise.all([
      accountId ? planOrGone(accountId) : Promise.resolve(null),
      accountId && profileId ? repos.profiles.get(accountId, profileId) : Promise.resolve(null),
      accountId ? repos.events.consentsAt(accountId, receivedAt) : Promise.resolve([]),
    ]);
    // An account erased (or a profile deleted) since: nothing to attribute the event to.
    if (accountId && (membership === null || membership === "gone")) {
      return { skipped: "account_gone" };
    }
    if (profileId && !profile) return { skipped: "profile_gone" };
    if (profile && isRestrictedProfile(profile)) return { skipped: "restricted" };
    const consent = accountId
      ? effectiveConsent(mode(), latest)
      : deviceConsent(mode(), undefined, false);
    if (event.type !== "consent.change" && !anyConsent(consent)) return { skipped: "no_consent" };
    const candidate = {
      eventId: event.eventId,
      type: event.type,
      version: EVENT_VERSION,
      source: "server",
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
      deviceId: event.deviceId,
      sessionSeq: null,
      app: { platform: "server", version: config.events.serverRelease },
      context: event.context,
      subject: await subjectOf({
        accountId,
        profileId,
        plan: membership && membership !== "gone" ? membership.plan : null,
        country: null,
        consent,
      }),
      payload: event.payload,
    };
    const parsed = LakeEvent.safeParse(candidate);
    if (!parsed.success) {
      logger.error("events.server_event_invalid", {
        type: event.type,
        eventId: event.eventId,
        issues: parsed.error.issues.slice(0, 5),
      });
      return { skipped: "invalid" };
    }
    return { event: parsed.data };
  }

  /**
   * Write events to the lake: validate each (a stamped event that fails is a bug: logged with
   * its id, never silently dropped), append the rest. A failed append rejects, so the job is
   * retried: an append that failed half-way stores its first partitions twice, which the
   * readers' deduplication by `eventId` absorbs; after the last attempt the job and its events
   * wait in the dead-letter queue for a replay.
   */
  async function writeLake(events: readonly unknown[]): Promise<number> {
    const valid: LakeEvent[] = [];
    const invalid: string[] = [];
    for (const event of events) {
      const parsed = LakeEvent.safeParse(event);
      if (parsed.success) valid.push(parsed.data);
      else invalid.push(String((event as { eventId?: unknown } | null)?.eventId ?? "?"));
    }
    if (invalid.length > 0) {
      logger.error("events.invalid_dropped", {
        count: invalid.length,
        eventIds: invalid.slice(0, 20),
      });
    }
    const kept = await withoutErasedSubjects(valid);
    if (kept.length === 0) return 0;
    await eventSink.append(kept);
    return kept.length;
  }

  /**
   * An erased subject's events are never stored again (privacy review L6): a late replay of a
   * dead-lettered append, or anything still in flight when an erasure starts. Every event of an
   * account being erased goes; an event of a profile erased on its own (it became restricted)
   * goes when it was received before that erasure was asked for. One read per batch.
   */
  async function withoutErasedSubjects(events: LakeEvent[]): Promise<LakeEvent[]> {
    const subjects = new Set<string>();
    for (const event of events) {
      if (event.subject.account) subjects.add(event.subject.account);
      if (event.subject.profile) subjects.add(event.subject.profile);
    }
    if (subjects.size === 0) return events;
    const erased = new Map(
      (await repos.events.erasuresOf([...subjects])).map((record) => [record.subjectKey, record]),
    );
    if (erased.size === 0) return events;
    const kept = events.filter((event) => {
      if (event.subject.account && erased.get(event.subject.account)?.kind === "account") {
        return false;
      }
      const profile = event.subject.profile ? erased.get(event.subject.profile) : undefined;
      if (!profile) return true;
      return profile.accountKey === null && Date.parse(event.receivedAt) > profile.requestedAt;
    });
    if (kept.length < events.length) {
      logger.info("events.erased_subject_dropped", { count: events.length - kept.length });
    }
    return kept;
  }

  return { ingest, emitServerEvent, stampServerEvent, writeLake };
}

export type Collector = ReturnType<typeof createCollector>;
