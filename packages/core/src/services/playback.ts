import {
  type ActiveStream,
  type HeartbeatAck,
  mediaUrlForBlobKey,
  type PlaybackSession,
  type PlaybackState,
  videoQualityForHeight,
} from "@webflix/contracts";
import { isRestrictedProfile, toOutboxEvent } from "../areas/events/collector.ts";
import {
  type AbandonReason,
  heartbeatCredit,
  isCompleted,
  type PlaybackEventType,
  type PlaybackSnapshot,
  playbackEvent,
  quartersCrossed,
} from "../areas/events/playback-events.ts";
import { AppError } from "../errors.ts";
import { toIsoString } from "../ports/clock.ts";
import { serializeError } from "../ports/logger.ts";
import type { StreamLease } from "../ports/stream-gate.ts";
import {
  COMPLETION_RATIO,
  type Personalization,
  resumePositionOf,
} from "../recommendations/engine.ts";
import { utcDay } from "../recommendations/hash.ts";
import type { OutboxEvent } from "../repositories/ports.ts";
import type { EpisodeSummary, PlaybackSessionRecord } from "../repositories/records.ts";
import type { ServiceDependencies, Viewer } from "./context.ts";
import { statsRollupJob } from "./jobs.ts";
import { presentEpisodeRef } from "./presenters.ts";
import { playbackEntitlement } from "./subscriptions.ts";

export interface StartPlaybackInput {
  titleId: string;
  episodeId?: string | undefined;
  startPositionSec?: number | undefined;
}

export interface HeartbeatInput {
  positionSec: number;
  durationSec: number;
  state: PlaybackState;
}

export interface MediaAccess {
  playbackSessionId: string;
  /** Token expiry, epoch ms (media responses must not be cached past it). */
  expiresAt: number;
  /**
   * The plan's rendition cap: master playlists are rewritten to it and renditions above it are
   * refused. From the token (stateless); for playlists of a token without it, from the session.
   */
  maxVideoHeight: number | null;
}

function presentActiveStream(lease: StreamLease): ActiveStream {
  return {
    playbackSessionId: lease.playbackSessionId,
    deviceLabel: lease.deviceLabel,
    titleName: lease.titleName,
    startedAt: toIsoString(lease.acquiredAt),
    lastSeenAt: toIsoString(lease.renewedAt),
  };
}

/**
 * Playback sessions, stream limits and media authorisation.
 *
 * Stream limits vs stateless media tokens (FOUNDATION §6, decided in docs/DECISIONS.md):
 * the plan limit is enforced when a session starts and on every heartbeat (a revoked slot
 * answers `playback_session_ended`); media tokens stay stateless for segments, subtitles and
 * trick-play, but every playlist request (`.m3u8`) also checks that the session still holds
 * its stream slot. A copied URL therefore stops working for new players and rendition
 * switches as soon as the slot is gone, while segment requests (the bulk of traffic) never
 * touch the database or the gate.
 *
 * Milestone 2: playback produces the server events `playback.start`, `progress`, `complete`
 * and `abandon` (areas/events/playback-events.ts). They are written to the event outbox in the
 * same batch as the playback write that produced them (`outbox` on the repository calls), and
 * the events area drains the outbox to the lake: what the routes return, their database round
 * trips and their binding calls are exactly what they were (apps/edge test/budgets.test.ts).
 * A kids or restricted profile's playback writes none.
 */
export function createPlaybackService(
  deps: ServiceDependencies,
  personalize: (viewer: Viewer) => Promise<Personalization>,
) {
  const { repos, clock, ids, streamGate, mediaTokens, config, logger, jobs } = deps;

  /** One playback event as an outbox row; null when there is none to write (or it is invalid). */
  async function outboxEvent<T extends PlaybackEventType>(
    type: T,
    milestone: string,
    snapshot: PlaybackSnapshot,
    extra: Parameters<typeof playbackEvent<T>>[3],
    now: number,
  ): Promise<OutboxEvent | null> {
    try {
      const event = await playbackEvent(type, milestone, snapshot, extra, now);
      return event ? toOutboxEvent(event, now) : null;
    } catch (error) {
      // A behaviour event must never fail playback.
      logger.warn("playback.event_failed", { type, error: serializeError(error) });
      return null;
    }
  }

  /** The abandonment of a session that ends without having completed its item. */
  async function abandonment(
    record: PlaybackSessionRecord,
    reason: AbandonReason,
    now: number,
  ): Promise<OutboxEvent[]> {
    if (isCompleted(record.state, record.positionSec, record.durationSec)) return [];
    const event = await outboxEvent(
      "playback.abandon",
      "abandon",
      {
        record,
        positionSec: record.positionSec,
        durationSec: record.durationSec,
        watchedSec: record.watchedSec,
      },
      { reason },
      now,
    );
    return event ? [event] : [];
  }

  /**
   * Whether a session's events may be written: never for a kids or restricted profile. Known
   * when the session is the viewer's own profile; otherwise the events area's drain decides.
   */
  function collects(viewer: Viewer, record: Pick<PlaybackSessionRecord, "profileId">): boolean {
    return record.profileId !== viewer.profile.id || !isRestrictedProfile(viewer.profile);
  }

  async function publishRollup(startedAt: number): Promise<void> {
    try {
      await jobs.publish(statsRollupJob.create({ day: utcDay(startedAt) }), { delaySec: 5 });
    } catch (error) {
      // Stats are eventually consistent; the scheduled rollup catches up.
      logger.warn("playback.rollup_publish_failed", { error: serializeError(error) });
    }
  }

  /** A playback session of the viewer's own profile (anyone else's does not exist for it). */
  async function ownSession(viewer: Viewer, playbackSessionId: string) {
    const record = await repos.playback.get(playbackSessionId);
    if (!record || record.profileId !== viewer.profile.id) {
      throw new AppError("not_found", { detail: "No such playback session" });
    }
    return record;
  }

  /**
   * Apply one progress report under every heartbeat rule: the session must still be running
   * and hold its stream slot (a revoked or expired slot ends it), the position is clamped to
   * the duration, completion is decided here, and credit is bounded by the repository (see
   * `recordHeartbeat`). `ends`: this is the final report and ends the session with it.
   */
  async function applyReport(
    record: PlaybackSessionRecord,
    input: HeartbeatInput,
    ends: boolean,
    collect: boolean,
  ): Promise<void> {
    if (record.endedAt !== null) throw new AppError("playback_session_ended");
    const lease = await streamGate.renew(record.accountId, record.id, config.playback.leaseTtlSec);
    const now = clock.now();
    if (!lease) {
      // Revoked (sign-out, plan change, another device took the slot) or expired.
      await repos.playback.end(record.id, now, {
        outbox: collect ? await abandonment(record, "stalled", now) : [],
      });
      await publishRollup(record.startedAt);
      throw new AppError("playback_session_ended");
    }
    const durationSec = input.durationSec > 0 ? input.durationSec : record.durationSec;
    const positionSec = Math.min(input.positionSec, durationSec || input.positionSec);
    const completed =
      input.state === "ended" || (durationSec > 0 && positionSec >= durationSec * COMPLETION_RATIO);
    // A late heartbeat is still credited (up to the wall-clock bound); a lost minute is not.
    const maxCreditSec = config.playback.heartbeatIntervalSec * 3;
    // The credit this write applies, computed from the same previous values the repository
    // uses (no read): the milestones the report crosses go in the same batch.
    const watchedSec = record.watchedSec + heartbeatCredit(record, positionSec, now, maxCreditSec);
    const outbox: OutboxEvent[] = [];
    if (collect) {
      const snapshot = { record, positionSec, durationSec, watchedSec };
      const milestones: Promise<OutboxEvent | null>[] = quartersCrossed(
        record.watchedSec,
        watchedSec,
        durationSec,
      ).map((quarter) =>
        outboxEvent("playback.progress", `progress:${quarter}`, snapshot, {}, now),
      );
      const wasCompleted = isCompleted(record.state, record.positionSec, record.durationSec);
      if (completed && !wasCompleted) {
        milestones.push(outboxEvent("playback.complete", "complete", snapshot, {}, now));
      } else if (ends && !completed && !wasCompleted) {
        milestones.push(
          outboxEvent("playback.abandon", "abandon", snapshot, { reason: "closed" }, now),
        );
      }
      for (const event of await Promise.all(milestones)) if (event) outbox.push(event);
    }
    await repos.playback.recordHeartbeat({
      playbackSessionId: record.id,
      profileId: record.profileId,
      titleId: record.titleId,
      episodeId: record.episodeId,
      positionSec,
      durationSec,
      state: input.state,
      completed,
      now,
      maxCreditSec,
      historyId: ids.next(),
      ends,
      ...(outbox.length > 0 ? { outbox } : {}),
    });
  }

  return {
    async start(viewer: Viewer, input: StartPlaybackInput): Promise<PlaybackSession> {
      const accountId = viewer.session.accountId;
      const [personalization, account] = await Promise.all([
        personalize(viewer),
        repos.accounts.get(accountId),
      ]);
      if (!account) throw new AppError("unauthenticated");
      const { snapshot } = personalization;
      const title = snapshot.title(input.titleId);
      if (!title) throw new AppError("not_found", { detail: "No such title" });
      if (!personalization.isVisible(title.id)) {
        throw new AppError("maturity_restricted", {
          maturity: title.maturity,
          profileMaturityCeiling: viewer.profile.maturityCeiling,
        });
      }
      const now = clock.now();
      // Billing decides (milestone 2: the membership projection's entitlement, §5.2).
      const plan = await playbackEntitlement(deps, account, now);

      let episode: EpisodeSummary | undefined;
      if (title.type === "series") {
        if (input.episodeId !== undefined) {
          episode = snapshot.episode(input.episodeId);
          if (!episode || episode.titleId !== title.id) {
            throw new AppError("not_found", { detail: "No such episode" });
          }
        } else {
          episode = personalization.playTarget(title.id)?.episode ?? undefined;
          if (!episode) throw new AppError("media_unavailable");
        }
      } else if (input.episodeId !== undefined) {
        throw new AppError("not_found", { detail: "Movies have no episodes" });
      }

      const assetId = episode ? episode.videoAssetId : title.videoAssetId;
      if (!assetId || (episode ? !episode.isPlayable : !title.isPlayable)) {
        throw new AppError("media_unavailable");
      }
      const next = episode ? snapshot.nextEpisode(episode.id) : undefined;
      const media = await repos.catalog.loadPlaybackMedia({
        assetId,
        episodeIds: next ? [next.id] : [],
      });
      const asset = media.asset;
      if (!asset || asset.kind === "unavailable") throw new AppError("media_unavailable");

      const playbackSessionId = ids.next();
      const lease = await streamGate.acquire({
        accountId,
        playbackSessionId,
        deviceId: viewer.session.id,
        deviceLabel: viewer.session.deviceLabel,
        titleName: episode ? `${title.name}: ${episode.name}` : title.name,
        limit: plan.maxStreams,
        leaseTtlSec: config.playback.leaseTtlSec,
      });
      if (!lease.ok) {
        throw new AppError("stream_limit_reached", {
          limit: plan.maxStreams,
          activeStreams: lease.active.map(presentActiveStream),
        });
      }

      const itemId = episode?.id ?? title.id;
      const durationSec = asset.durationSec ?? episode?.runtimeSec ?? title.runtimeSec ?? 0;
      // The rule every play target and Continue Watching use: resume what is in progress.
      const resumePositionSec = Math.max(
        0,
        Math.min(
          input.startPositionSec ?? resumePositionOf(personalization.itemProgress(itemId)),
          Math.max(0, durationSec - 1),
        ),
      );

      const record: PlaybackSessionRecord = {
        id: playbackSessionId,
        accountId,
        profileId: viewer.profile.id,
        sessionId: viewer.session.id,
        titleId: title.id,
        episodeId: episode?.id ?? null,
        assetId: asset.kind === "packaged" ? asset.id : null,
        maxVideoHeight: plan.maxVideoHeight,
        startedAt: now,
        lastHeartbeatAt: now,
        endedAt: null,
        positionSec: resumePositionSec,
        durationSec,
        watchedSec: 0,
        state: "playing",
      };
      let replaced: PlaybackSessionRecord | null = null;
      const startEvent = isRestrictedProfile(viewer.profile)
        ? null
        : await outboxEvent(
            "playback.start",
            "start",
            { record, positionSec: resumePositionSec, durationSec, watchedSec: 0 },
            {},
            now,
          );
      try {
        await repos.playback.create(record, startEvent ? { outbox: [startEvent] } : {});
        if (lease.replaced) {
          replaced = await repos.playback.get(lease.replaced);
          await repos.playback.end(lease.replaced, now, {
            outbox:
              replaced && collects(viewer, replaced)
                ? await abandonment(replaced, "replaced", now)
                : [],
          });
        }
      } catch (error) {
        await streamGate.release(accountId, playbackSessionId);
        throw error;
      }
      // The session this device left counts like one that was released.
      if (replaced && replaced.endedAt === null) await publishRollup(replaced.startedAt);

      let manifestUrl: string;
      let expiresAt = now + config.media.tokenTtlSec * 1000;
      let token: string | null = null;
      if (asset.kind === "packaged" && asset.masterKey) {
        const issued = await mediaTokens.issue({
          assetId: asset.id,
          playbackSessionId,
          ttlSec: config.media.tokenTtlSec,
          maxVideoHeight: plan.maxVideoHeight,
        });
        token = issued.token;
        expiresAt = issued.expiresAt;
        manifestUrl = mediaUrlForBlobKey(issued.token, asset.masterKey);
      } else if (asset.externalUrl) {
        manifestUrl = asset.externalUrl;
      } else {
        throw new AppError("media_unavailable");
      }
      const signed = (key: string) => (token ? mediaUrlForBlobKey(token, key) : key);
      const nextRecord = next
        ? media.episodes.find((candidate) => candidate.id === next.id)
        : undefined;

      return {
        id: playbackSessionId,
        titleId: title.id,
        episodeId: episode?.id ?? null,
        manifestUrl,
        expiresAt: toIsoString(expiresAt),
        durationSec,
        resumePositionSec,
        textTracks: token
          ? asset.textTracks.map((track) => ({
              id: track.id,
              language: track.language,
              label: track.label,
              kind: track.kind,
              url: signed(track.key),
              default: track.default,
              forced: track.forced,
            }))
          : [],
        trickPlay:
          token && asset.trickPlay
            ? {
                intervalSec: asset.trickPlay.intervalSec,
                tileWidth: asset.trickPlay.tileWidth,
                tileHeight: asset.trickPlay.tileHeight,
                columns: asset.trickPlay.columns,
                rows: asset.trickPlay.rows,
                count: asset.trickPlay.count,
                sheets: asset.trickPlay.sheets.map(signed),
              }
            : null,
        markers: {
          intro: asset.markers.intro,
          recap: asset.markers.recap,
          creditsStartSec: asset.markers.creditsStartSec,
        },
        nextEpisode: next?.isPlayable
          ? {
              episode: presentEpisodeRef(next),
              synopsis: nextRecord?.synopsis ?? "",
              runtimeSec: next.runtimeSec,
              still: nextRecord?.still ?? null,
            }
          : null,
        heartbeatIntervalSec: config.playback.heartbeatIntervalSec,
        maxVideoHeight: plan.maxVideoHeight,
        ...(asset.kind === "packaged" && asset.maxHeight !== null
          ? { bestVideoQuality: videoQualityForHeight(asset.maxHeight) }
          : {}),
        autoplayNextEpisode: viewer.profile.settings.autoplayNextEpisode,
        display: {
          titleName: title.name,
          titleType: title.type,
          episode: episode ? presentEpisodeRef(episode) : null,
          maturity: title.maturity,
          maturityDescriptors: [...title.maturityDescriptors],
          logo: title.images.logo,
        },
      };
    },

    async heartbeat(
      viewer: Viewer,
      playbackSessionId: string,
      input: HeartbeatInput,
    ): Promise<HeartbeatAck> {
      const record = await ownSession(viewer, playbackSessionId);
      await applyReport(record, input, false, collects(viewer, record));
      return { heartbeatIntervalSec: config.playback.heartbeatIntervalSec };
    },

    /**
     * Stop playback and free the stream slot. Without `final`: idempotent, and any profile of
     * the account may release the slot. With `final` (the last progress report, so one request
     * is enough when a page closes): it is applied exactly like a heartbeat and the session ends
     * in the same write, then the slot is freed. A refused report (`playback_session_ended`)
     * still frees the slot; another profile's session is `not_found` and left as it is.
     */
    async end(viewer: Viewer, playbackSessionId: string, final?: HeartbeatInput): Promise<void> {
      if (final) {
        const record = await ownSession(viewer, playbackSessionId);
        try {
          await applyReport(record, final, true, collects(viewer, record));
        } finally {
          await streamGate.release(record.accountId, record.id);
        }
        await publishRollup(record.startedAt);
        return;
      }
      const record = await repos.playback.get(playbackSessionId);
      if (!record || record.accountId !== viewer.session.accountId) return;
      await streamGate.release(record.accountId, record.id);
      if (record.endedAt === null) {
        const now = clock.now();
        await repos.playback.end(record.id, now, {
          outbox: collects(viewer, record) ? await abandonment(record, "closed", now) : [],
        });
        await publishRollup(record.startedAt);
      }
    },

    /**
     * Authorise one `/media/{token}/vod/{assetId}/...` request. Stateless for segments; for
     * playlists, also require the playback session to still hold its stream slot.
     */
    async authorizeMedia(token: string, assetId: string, key: string): Promise<MediaAccess> {
      const verification = await mediaTokens.verify(token, assetId);
      if (!verification.valid) {
        throw new AppError(
          verification.reason === "expired" ? "media_token_expired" : "media_token_invalid",
        );
      }
      const { playbackSessionId, exp, maxVideoHeight } = verification.claims;
      if (!key.endsWith(".m3u8")) {
        return { playbackSessionId, expiresAt: exp * 1000, maxVideoHeight };
      }
      const record = await repos.playback.get(playbackSessionId);
      if (!record || record.endedAt !== null) throw new AppError("playback_session_ended");
      const leases = await streamGate.list(record.accountId);
      if (!leases.some((lease) => lease.playbackSessionId === playbackSessionId)) {
        throw new AppError("playback_session_ended");
      }
      return {
        playbackSessionId,
        expiresAt: exp * 1000,
        maxVideoHeight: maxVideoHeight ?? record.maxVideoHeight,
      };
    },
  };
}

export type PlaybackService = ReturnType<typeof createPlaybackService>;

/**
 * Drop variants taller than `maxHeight` from an HLS master playlist (the plan's quality cap,
 * enforced server-side as well as by the player). Media playlists pass through unchanged. If
 * every variant is too tall, the shortest one is kept so playback still works.
 */
export function capMasterPlaylist(text: string, maxHeight: number): string {
  if (!text.includes("#EXT-X-STREAM-INF")) return text;
  const lines = text.split(/\r?\n/);
  const allowed = allowedHeight(lines, maxHeight);
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const height = heightOf(line);
    if (line.startsWith("#EXT-X-STREAM-INF") && height !== null && height > allowed) {
      index += 1; // skip the variant's URI line too
      continue;
    }
    if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF") && height !== null && height > allowed)
      continue;
    out.push(line);
  }
  return out.join("\n");
}

function heightOf(line: string): number | null {
  const match = /RESOLUTION=(\d+)x(\d+)/.exec(line);
  return match ? Number(match[2]) : null;
}

/** The tallest height a capped master keeps: the cap, or the shortest variant if all exceed it. */
function allowedHeight(lines: readonly string[], maxHeight: number): number {
  const variantHeights = lines
    .filter((line) => line.startsWith("#EXT-X-STREAM-INF"))
    .map(heightOf)
    .filter((height): height is number => height !== null);
  return variantHeights.some((height) => height <= maxHeight)
    ? maxHeight
    : Math.min(...variantHeights);
}

/**
 * The renditions `capMasterPlaylist` leaves out, as the directories their playlists live in
 * (`1080p/`), relative to the master. Requests under them are refused, so a player cannot reach
 * a taller rendition by guessing its URL. A directory that also holds a rendition within the cap
 * (or a variant beside the master) cannot be refused as a whole and is not listed.
 */
export function renditionsAboveCap(text: string, maxHeight: number): string[] {
  if (!text.includes("#EXT-X-STREAM-INF")) return [];
  const lines = text.split(/\r?\n/);
  const allowed = allowedHeight(lines, maxHeight);
  const tall = new Set<string>();
  const kept = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const height = heightOf(line);
    if (height === null) continue;
    let uri: string | undefined;
    if (line.startsWith("#EXT-X-STREAM-INF")) uri = lines[index + 1]?.trim();
    else if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF")) uri = /URI="([^"]+)"/.exec(line)?.[1];
    if (!uri || uri.includes("://") || uri.startsWith("/")) continue;
    const directory = uri.slice(0, uri.lastIndexOf("/") + 1);
    (height > allowed ? tall : kept).add(directory);
  }
  return [...tall].filter((directory) => directory !== "" && !kept.has(directory));
}
