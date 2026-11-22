import type {
  ConsentState,
  DataExport,
  EventBatchAck,
  PrivacyRequest,
  PrivacyRequestList,
  RecentEvents,
  RecentEventsQuery,
  UpdateConsentBody,
} from "@webflix/contracts";
import { LakeEvent } from "@webflix/contracts";
import { AppError } from "../../errors.ts";
import { createSubjectKeys, type SubjectKind } from "../../ports/event-sink.ts";
import { handleJob } from "../../ports/job-queue.ts";
import type { Logger } from "../../ports/logger.ts";
import { HEARTBEAT_CARRY_SEC, type OutboxEvent } from "../../repositories/ports.ts";
import type { AuthContext, ServiceDependencies } from "../../services/context.ts";
import type { AreaModule, ServerEventInput } from "../module.ts";
import {
  createCollector,
  type IngestRequest,
  isRestrictedProfile,
  toOutboxEvent,
} from "./collector.ts";
import { type ConsentFlags, presentConsentState } from "./consent.ts";
import {
  appendEventsJob,
  drainOutboxJob,
  playbackExpiryJob,
  privacyEraseJob,
  privacyExportJob,
  privacySweepJob,
  serverEventJob,
} from "./jobs.ts";
import { createConsentLedger } from "./ledger.ts";
import type { OtherAreas } from "./neighbours.ts";
import { isCompleted, playbackEvent } from "./playback-events.ts";
import { createPrivacy } from "./privacy.ts";
import type { ConsentPurposeName } from "./repository.ts";

const HOUR_MS = 3600 * 1000;
/** Outbox rows stamped and appended per round, and rounds per run (bounded work). */
const OUTBOX_BATCH = 100;
const OUTBOX_ROUNDS = 10;
const READ_BACK_MAX_WINDOW_MS = 7 * 24 * HOUR_MS;
/** Open sessions examined per expiry run, and the slack past the slot's lapse before one is. */
const EXPIRY_BATCH = 100;
const EXPIRY_MARGIN_SEC = 60;

export type { IngestRequest } from "./collector.ts";

/** Read-back filters (`GET /diagnostics/events`, the staff view). */
export interface RecentEventsFilter {
  profileId?: string | undefined;
  deviceId?: string | undefined;
  /** ISO instant; default an hour ago, at most a week back. */
  since?: string | undefined;
  limit?: number | undefined;
}

/**
 * Methods the staff API needs (wired by the admin area after this wave; role checks and audit
 * entries are the admin handlers'). None returns a member's download link.
 */
export interface EventsStaffMethods {
  /** The account's consent in force, per purpose, with its source. */
  consent(accountId: string): Promise<ConsentState>;
  /** A support agent records the member's answer (`source: support`; emits `consent.change`). */
  setConsent(
    accountId: string,
    purpose: ConsentPurposeName,
    granted: boolean,
  ): Promise<ConsentState>;
  /** The account's exports and deletion requests, newest first (no download links). */
  privacyRequests(accountId: string): Promise<PrivacyRequest[]>;
  /** Cancel a deletion during its cooling-off period; false when none is scheduled. */
  cancelDeletion(accountId: string): Promise<boolean>;
  /** What the lake holds for the account recently (newest first). */
  recentEvents(accountId: string, filter: RecentEventsFilter): Promise<RecentEvents>;
  /** Pseudonymous account keys the next compaction must erase (`compact --erase FILE`). */
  pendingErasures(limit: number): Promise<string[]>;
  /** Compaction dropped these keys' events. */
  confirmErasures(subjectKeys: readonly string[]): Promise<void>;
}

/**
 * The events area (milestone 2 §6): ingestion of client batches, server events, the event lake
 * through `deps.eventSink` (validated `LakeEvent`s, partitioned by receipt hour), consent,
 * pseudonymous subject keys, export and deletion. Owns the `emitServerEvent` seam every other
 * area calls, and milestone 1's playback service (services/playback.ts), which emits the
 * playback events.
 */
export interface EventsService extends AreaModule {
  /** The `AreaSeams.emitServerEvent` seam (see areas/module.ts). Never throws. */
  emitServerEvent(event: ServerEventInput): Promise<void>;
  /** `POST /events`. */
  ingest(request: IngestRequest): Promise<EventBatchAck>;
  /** `GET /privacy/consent` (signed in or not). */
  getConsent(auth: AuthContext | null, options: { gpc: boolean }): Promise<ConsentState>;
  /** `PUT /privacy/consent`. */
  updateConsent(
    auth: AuthContext,
    body: UpdateConsentBody,
    options: { gpc: boolean },
  ): Promise<ConsentState>;
  /** `POST /privacy/export`. */
  requestExport(auth: AuthContext): Promise<PrivacyRequest>;
  /** `GET /privacy/requests`. */
  listPrivacyRequests(auth: AuthContext): Promise<PrivacyRequestList>;
  /** `GET /privacy/exports/:id?token=`. */
  downloadExport(auth: AuthContext, requestId: string, token: string): Promise<DataExport>;
  /** `POST /account/deletion`. */
  requestDeletion(auth: AuthContext): Promise<PrivacyRequest>;
  /** `DELETE /account/deletion`. */
  cancelDeletion(auth: AuthContext): Promise<void>;
  /** `GET /diagnostics/events` (not in production). */
  recentEvents(auth: AuthContext, query: RecentEventsQuery): Promise<RecentEvents>;
  /** The lake's pseudonymous key of an account or profile (serving derives the same). */
  subjectKey(kind: SubjectKind, id: string): Promise<string>;
  staff: EventsStaffMethods;
}

export interface EventsServiceOptions {
  /**
   * The other areas' services (the member's plan, the account behind an export, every area's
   * export and erasure hooks), resolved when used: they are built after this one.
   */
  otherAreas: OtherAreas;
}

export function createEventsService(
  deps: ServiceDependencies,
  options: EventsServiceOptions,
): EventsService {
  const { clock, config, eventSink } = deps;
  const keys = createSubjectKeys(config.events.pseudonymKey);
  // The ledger emits `consent.change` through the collector's seam implementation.
  const ledger = createConsentLedger(deps, (event) => collector.emitServerEvent(event));
  const collector = createCollector(deps, keys, ledger, options.otherAreas);
  const privacy = createPrivacy(deps, keys, options.otherAreas, () => drainOutbox(deps.logger));

  /**
   * End the playback sessions nobody released (a killed tab, a lost network): their stream slot
   * lapsed and no report came back. Each is ended once (the write ends only an open session)
   * with its `playback.abandon` (`expired`) in the same batch, unless it had completed or its
   * profile is restricted. A session whose slot is still held is left alone. Bounded per run.
   */
  async function expireAbandonedPlayback(logger: Logger): Promise<number> {
    const now = clock.now();
    const cutoff =
      now - (config.playback.leaseTtlSec + HEARTBEAT_CARRY_SEC + EXPIRY_MARGIN_SEC) * 1000;
    const sessions = await deps.repos.events.openPlaybackBefore(cutoff, EXPIRY_BATCH);
    const held = new Map<string, Set<string>>();
    let ended = 0;
    for (const session of sessions) {
      let slots = held.get(session.accountId);
      if (!slots) {
        const leases = await deps.streamGate.list(session.accountId);
        slots = new Set(leases.map((lease) => lease.playbackSessionId));
        held.set(session.accountId, slots);
      }
      if (slots.has(session.id)) continue;
      const profile = await deps.repos.profiles.get(session.accountId, session.profileId);
      const outbox: OutboxEvent[] = [];
      if (
        profile &&
        !isRestrictedProfile(profile) &&
        !isCompleted(session.state, session.positionSec, session.durationSec)
      ) {
        const event = await playbackEvent(
          "playback.abandon",
          "abandon",
          {
            record: session,
            positionSec: session.positionSec,
            durationSec: session.durationSec,
            watchedSec: session.watchedSec,
          },
          { reason: "expired" },
          // Playback stopped at the last report (the credit clock stays within seconds of it).
          session.lastHeartbeatAt,
        );
        if (event) outbox.push(toOutboxEvent(event, now));
      }
      await deps.repos.playback.end(session.id, now, { outbox });
      ended += 1;
    }
    if (ended > 0) logger.info("playback.expired_sessions_ended", { sessions: ended });
    return ended;
  }

  /**
   * Move the event outbox to the lake: stamp each row's server event (privacy rules applied),
   * append them, then delete the rows. A failed append leaves the rows for the next run (at
   * least once); a row that cannot be read is a bug, logged and removed. Bounded per run.
   */
  async function drainOutbox(logger: Logger): Promise<number> {
    let stored = 0;
    for (let round = 0; round < OUTBOX_ROUNDS; round += 1) {
      const rows = await deps.repos.events.takeOutbox(OUTBOX_BATCH);
      if (rows.length === 0) break;
      const events: LakeEvent[] = [];
      for (const row of rows) {
        let payload: ReturnType<typeof serverEventJob.schema.parse>;
        try {
          payload = serverEventJob.schema.parse(JSON.parse(row.payload));
        } catch {
          logger.error("events.outbox_unreadable", { id: row.id });
          continue;
        }
        const outcome = await collector.stampServerEvent(payload);
        if ("event" in outcome) events.push(outcome.event);
        else logger.debug("events.server_event_skipped", { id: row.id, reason: outcome.skipped });
      }
      if (events.length > 0) stored += await collector.writeLake(events);
      await deps.repos.events.deleteOutbox(rows.map((row) => row.id));
      if (rows.length < OUTBOX_BATCH) break;
    }
    return stored;
  }

  async function readBack(accountId: string, filter: RecentEventsFilter): Promise<RecentEvents> {
    const now = clock.now();
    const requested = filter.since ? Date.parse(filter.since) : now - HOUR_MS;
    const since = Math.max(
      Number.isFinite(requested) ? requested : now - HOUR_MS,
      now - READ_BACK_MAX_WINDOW_MS,
    );
    const limit = filter.limit ?? 100;
    const accountKey = await keys.account(accountId);
    const profileKey = filter.profileId ? await keys.profile(filter.profileId) : null;
    const matches: LakeEvent[] = [];
    let cursor: string | null = null;
    do {
      const page = await eventSink.scan({ fromMs: since, toMs: now + HOUR_MS, cursor, limit: 100 });
      for (const object of page.objects) {
        for (const raw of object.events) {
          const parsed = LakeEvent.safeParse(raw);
          if (!parsed.success) continue;
          const event = parsed.data;
          if (Date.parse(event.receivedAt) < since) continue;
          // The account's events; signed-out ones only by the device that sent them.
          const mine =
            event.subject.account === accountKey ||
            (event.subject.account === null &&
              filter.deviceId !== undefined &&
              event.deviceId === filter.deviceId);
          if (!mine) continue;
          if (profileKey && event.subject.profile !== profileKey) continue;
          if (filter.deviceId !== undefined && event.deviceId !== filter.deviceId) continue;
          matches.push(event);
        }
      }
      cursor = page.cursor;
    } while (cursor !== null);
    matches.sort((a, b) =>
      a.receivedAt === b.receivedAt
        ? a.eventId < b.eventId
          ? 1
          : -1
        : a.receivedAt < b.receivedAt
          ? 1
          : -1,
    );
    return { items: matches.slice(0, limit) };
  }

  function signedOutConsent(gpc: boolean): ConsentState {
    const state = presentConsentState(config.events.consentMode, gpc, []);
    if (!gpc) return state;
    const withdrawn = { ...state.purposes.analytics, granted: false };
    return {
      ...state,
      purposes: { analytics: withdrawn, personalisation: { ...withdrawn } },
    };
  }

  const staff: EventsStaffMethods = {
    consent: (accountId) => ledger.state(accountId, { gpc: false }),
    async setConsent(accountId, purpose, granted) {
      await ledger.answer(accountId, purpose, granted, "support");
      return ledger.state(accountId, { gpc: false });
    },
    privacyRequests: (accountId) => privacy.list(accountId, { withLink: false }),
    cancelDeletion: (accountId) => privacy.cancelDeletion(accountId),
    recentEvents: (accountId, filter) => readBack(accountId, filter),
    async pendingErasures(limit) {
      return (await deps.repos.events.pendingErasures(limit))
        .filter((record) => record.kind === "account")
        .map((record) => record.subjectKey);
    },
    async confirmErasures(subjectKeys) {
      await deps.repos.events.markErasuresCompacted(subjectKeys, clock.now());
    },
  };

  return {
    jobs: [
      handleJob(appendEventsJob, async ({ events }, context) => {
        const written = await collector.writeLake(events);
        context.logger.debug("events.appended", { events: written });
      }),
      handleJob(serverEventJob, async (payload, context) => {
        const outcome = await collector.stampServerEvent(payload);
        if ("skipped" in outcome) {
          context.logger.debug("events.server_event_skipped", {
            type: payload.event.type,
            reason: outcome.skipped,
          });
          return;
        }
        await collector.writeLake([outcome.event]);
      }),
      handleJob(playbackExpiryJob, async (_payload, context) => {
        await expireAbandonedPlayback(context.logger);
      }),
      handleJob(drainOutboxJob, async (_payload, context) => {
        const stored = await drainOutbox(context.logger);
        if (stored > 0) context.logger.debug("events.outbox_drained", { events: stored });
      }),
      handleJob(privacyExportJob, ({ requestId }) => privacy.runExport(requestId)),
      handleJob(privacyEraseJob, ({ requestId }) => privacy.runErasure(requestId)),
      handleJob(privacySweepJob, () => privacy.sweep()),
    ],
    // The expiry sweep first: its abandonments are in the outbox before the drain runs.
    scheduled: () => [
      playbackExpiryJob.create({}),
      drainOutboxJob.create({}),
      privacySweepJob.create({}),
    ],

    emitServerEvent: (event) => collector.emitServerEvent(event),
    ingest: (request) => collector.ingest(request),

    async getConsent(auth, { gpc }) {
      if (!auth) return signedOutConsent(gpc);
      return ledger.state(auth.session.accountId, { gpc });
    },

    async updateConsent(auth, body, { gpc }) {
      // A kids or restricted profile is never profiled, so it has nothing to consent to; the
      // account holder answers for the account.
      if (auth.profile && isRestrictedProfile(auth.profile)) {
        throw new AppError("unrestricted_profile_required");
      }
      await ledger.answer(auth.session.accountId, body.purpose, body.granted, body.source);
      return ledger.state(auth.session.accountId, { gpc });
    },

    requestExport: (auth) => privacy.requestExport(auth),

    async listPrivacyRequests(auth) {
      return { items: await privacy.list(auth.session.accountId, { withLink: true }) };
    },

    downloadExport: (auth, requestId, token) => privacy.download(auth, requestId, token),
    requestDeletion: (auth) => privacy.requestDeletion(auth),

    async cancelDeletion(auth) {
      if (!(await privacy.cancelDeletion(auth.session.accountId))) {
        throw new AppError("not_found", { detail: "No deletion is scheduled" });
      }
    },

    async recentEvents(auth, query) {
      if (config.environment === "production") throw new AppError("not_found");
      // Diagnostics only: what playback left in the outbox is moved first, so a suite reads
      // its events back at once instead of after the next scheduler tick.
      await drainOutbox(deps.logger);
      return readBack(auth.session.accountId, {
        profileId: query.profileId,
        deviceId: query.deviceId,
        since: query.since,
        limit: query.limit === undefined ? undefined : Number(query.limit),
      });
    },

    subjectKey: (kind, id) => keys.of(kind, id),
    staff,
  };
}

export type { ConsentFlags };
