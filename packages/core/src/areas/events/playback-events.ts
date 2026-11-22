import type { EventPayload, PLAYBACK_ABANDON_REASONS, PlaybackState } from "@webflix/contracts";
import { hexEncode, utf8Encode } from "../../encoding.ts";
import { COMPLETION_RATIO } from "../../recommendations/engine.ts";
import type { PlaybackSessionRecord } from "../../repositories/records.ts";
import type { ServerEventInput } from "../module.ts";

/**
 * Playback's server events (milestone 2 §6.1; services/recs README decision 9): `start` when a
 * session starts, `progress` as credited watching crosses each quarter of the item, `complete`
 * when the item reaches the completion ratio or ends, `abandon` when a session ends without
 * completing. Emitted by services/playback.ts after its own writes, through the
 * `emitServerEvent` seam (which never throws), so a lost event never fails playback and the
 * routes answer and cost exactly what they did (no extra database round trip).
 */

export type AbandonReason = (typeof PLAYBACK_ABANDON_REASONS)[number];
export type PlaybackEventType =
  | "playback.start"
  | "playback.progress"
  | "playback.complete"
  | "playback.abandon";

/** Quarters of an item whose crossing by credited watching emits `playback.progress`. */
export const PLAYBACK_QUARTERS = [1, 2, 3] as const;

/**
 * The seconds one report credits, exactly as `PlaybackRepository.recordHeartbeat` computes them
 * in SQL from the session's previous values (packages/db/src/repositories/activity.ts): the
 * position advance, only if the session was playing or buffering, at most the wall-clock time
 * since the credit clock and at most `maxCreditSec`. A test compares the two on every dialect.
 */
export function heartbeatCredit(
  before: Pick<PlaybackSessionRecord, "state" | "positionSec" | "lastHeartbeatAt">,
  positionSec: number,
  now: number,
  maxCreditSec: number,
): number {
  if (before.state !== "playing" && before.state !== "buffering") return 0;
  return Math.max(
    0,
    Math.min(positionSec - before.positionSec, (now - before.lastHeartbeatAt) / 1000, maxCreditSec),
  );
}

/** Whether a position (or an `ended` state) counts as having finished the item. */
export function isCompleted(
  state: PlaybackState,
  positionSec: number,
  durationSec: number,
): boolean {
  return state === "ended" || (durationSec > 0 && positionSec >= durationSec * COMPLETION_RATIO);
}

/** The quarters (1..3) crossed when credited watching went from `fromSec` to `toSec`. */
export function quartersCrossed(fromSec: number, toSec: number, durationSec: number): number[] {
  if (durationSec <= 0) return [];
  return PLAYBACK_QUARTERS.filter((quarter) => {
    const threshold = (durationSec * quarter) / 4;
    return fromSec < threshold && toSec >= threshold;
  });
}

/**
 * A UUIDv7-shaped event id derived from the playback session and the milestone: the timestamp
 * field is the session's start, the random fields come from SHA-256(session, milestone). The
 * same milestone of the same session always gets the same id, so a milestone emitted twice
 * (two racing heartbeats, a completion reached again after seeking back) is one event once the
 * lake's readers deduplicate by `eventId`.
 */
export async function playbackEventId(
  playbackSessionId: string,
  startedAt: number,
  milestone: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", utf8Encode(`${playbackSessionId}:${milestone}`)),
  );
  const time = Math.max(0, Math.min(startedAt, 2 ** 48 - 1))
    .toString(16)
    .padStart(12, "0");
  const random = hexEncode(digest);
  const variant = ((Number.parseInt(random.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return [
    time.slice(0, 8),
    time.slice(8, 12),
    `7${random.slice(0, 3)}`,
    `${variant}${random.slice(4, 7)}`,
    random.slice(7, 19),
  ].join("-");
}

export interface PlaybackSnapshot {
  record: PlaybackSessionRecord;
  positionSec: number;
  durationSec: number;
  watchedSec: number;
}

/** One playback server event for the seam (null when the item has no known duration). */
export async function playbackEvent<T extends PlaybackEventType>(
  type: T,
  milestone: string,
  snapshot: PlaybackSnapshot,
  extra: T extends "playback.abandon" ? { reason: AbandonReason } : Record<never, never>,
  occurredAt: number,
): Promise<(ServerEventInput<T> & { eventId: string }) | null> {
  const { record } = snapshot;
  // The schema needs a positive duration; external fallback media may not have one.
  if (!(snapshot.durationSec > 0)) return null;
  const payload = {
    playbackSessionId: record.id,
    titleId: record.titleId,
    episodeId: record.episodeId,
    positionSec: Math.max(0, Math.min(snapshot.positionSec, snapshot.durationSec)),
    durationSec: snapshot.durationSec,
    watchedSec: Math.max(0, snapshot.watchedSec),
    ...extra,
  } as EventPayload<T>;
  return {
    type,
    payload,
    accountId: record.accountId,
    profileId: record.profileId,
    context: { surface: "player" },
    occurredAt,
    eventId: await playbackEventId(record.id, record.startedAt, milestone),
  };
}
