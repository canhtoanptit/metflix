import * as z from "zod";
import { Id, IsoDateTime, LanguageTag, ResourceUrl, Seconds, WholeSeconds } from "./common.ts";
import { PLAYBACK_STATES, TEXT_TRACK_KINDS } from "./constants.ts";
import { MaturityLevel } from "./maturity.ts";
import { ImageSet } from "./media.ts";
import { EpisodeRef, TitleType, VideoQualityTier } from "./titles.ts";

/** A WebVTT side-car track. Attach with `<track>` (native HLS) or hand to hls.js. */
export const TextTrack = z
  .object({
    id: Id,
    language: LanguageTag,
    label: z.string(),
    kind: z.enum(TEXT_TRACK_KINDS),
    url: ResourceUrl,
    default: z.boolean(),
    /** Forced narrative subtitles (foreign dialogue only). */
    forced: z.boolean(),
  })
  .meta({ id: "TextTrack" });
export type TextTrack = z.output<typeof TextTrack>;

/**
 * Trick-play thumbnails packed into sprite sheets laid out row-major.
 * Thumbnail `i` covers `[i * intervalSec, (i + 1) * intervalSec)` and lives in sheet
 * `floor(i / (columns * rows))` at cell `i % (columns * rows)`. See `trickPlayTile`
 * (`media-helpers.ts`).
 */
export const TrickPlay = z
  .object({
    intervalSec: z.number().positive(),
    tileWidth: z.number().int().positive(),
    tileHeight: z.number().int().positive(),
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
    /** Total number of thumbnails across all sheets. */
    count: z.number().int().nonnegative(),
    sheets: z.array(ResourceUrl),
  })
  .meta({ id: "TrickPlay" });
export type TrickPlay = z.output<typeof TrickPlay>;

export const TimeRange = z
  .object({ startSec: Seconds, endSec: Seconds })
  .refine((range) => range.endSec > range.startSec, { message: "endSec must be after startSec" })
  .meta({ id: "TimeRange" });
export type TimeRange = z.output<typeof TimeRange>;

/** Skip Intro / Skip Recap windows and where the end credits start (next-episode countdown). */
export const PlaybackMarkers = z
  .object({
    intro: TimeRange.nullable(),
    recap: TimeRange.nullable(),
    creditsStartSec: Seconds.nullable(),
  })
  .meta({ id: "PlaybackMarkers" });
export type PlaybackMarkers = z.output<typeof PlaybackMarkers>;

export const NextEpisode = z
  .object({
    episode: EpisodeRef,
    synopsis: z.string(),
    runtimeSec: WholeSeconds,
    still: ImageSet.nullable(),
  })
  .meta({ id: "NextEpisode" });
export type NextEpisode = z.output<typeof NextEpisode>;

export const CreatePlaybackSessionBody = z
  .object({
    titleId: Id,
    /** Required for series unless resuming; the server picks the episode to resume otherwise. */
    episodeId: Id.optional(),
    /** Override the stored resume position (e.g. "Play from beginning" passes 0). */
    startPositionSec: Seconds.optional(),
  })
  .meta({ id: "CreatePlaybackSessionBody" });
export type CreatePlaybackSessionBody = z.input<typeof CreatePlaybackSessionBody>;

/**
 * Everything the player needs to start. `manifestUrl` is either a signed same-origin
 * `/media/{token}/vod/{assetId}/master.m3u8` URL (packaged assets; relative URLs inside the
 * playlists inherit the token) or an absolute external HLS URL (fallback assets). The token
 * expires at `expiresAt`; on `media_token_expired` create a new session at the current position.
 */
export const PlaybackSession = z
  .object({
    id: Id,
    titleId: Id,
    episodeId: Id.nullable(),
    manifestUrl: ResourceUrl,
    expiresAt: IsoDateTime,
    durationSec: Seconds,
    /** Where to start: stored progress (or `startPositionSec`), 0 for a fresh start. */
    resumePositionSec: Seconds,
    textTracks: z.array(TextTrack),
    trickPlay: TrickPlay.nullable(),
    markers: PlaybackMarkers,
    nextEpisode: NextEpisode.nullable(),
    /** Send `POST /playback/sessions/:id/heartbeat` at this interval while the player is open. */
    heartbeatIntervalSec: z.number().int().positive(),
    /** Plan cap: the player must not select renditions taller than this. */
    maxVideoHeight: z.number().int().positive(),
    /**
     * Best quality of the media being played; label it with
     * `effectiveVideoQuality(bestVideoQuality, maxVideoHeight)`. Absent for external media.
     */
    bestVideoQuality: VideoQualityTier.optional(),
    /** Profile setting: start the next episode automatically after the countdown. */
    autoplayNextEpisode: z.boolean(),
    /** Overlay metadata (title, episode, maturity advisory shown at start). */
    display: z.object({
      titleName: z.string(),
      titleType: TitleType,
      episode: EpisodeRef.nullable(),
      maturity: MaturityLevel,
      maturityDescriptors: z.array(z.string()),
      logo: ImageSet.nullable(),
    }),
  })
  .meta({ id: "PlaybackSession" });
export type PlaybackSession = z.output<typeof PlaybackSession>;

export const PlaybackState = z.enum(PLAYBACK_STATES).meta({ id: "PlaybackState" });
export type PlaybackState = z.output<typeof PlaybackState>;

/**
 * A progress report. Also the optional body of `DELETE /playback/sessions/:id`, where it is the
 * final report of the session (validated and applied exactly like a heartbeat).
 */
export const HeartbeatBody = z
  .object({
    positionSec: Seconds,
    durationSec: Seconds,
    state: PlaybackState,
  })
  .meta({ id: "HeartbeatBody" });
export type HeartbeatBody = z.input<typeof HeartbeatBody>;

export const HeartbeatAck = z
  .object({
    /** The server may stretch or shrink the interval under load. */
    heartbeatIntervalSec: z.number().int().positive(),
  })
  .meta({ id: "HeartbeatAck" });
export type HeartbeatAck = z.output<typeof HeartbeatAck>;

/** A stream currently counted against the plan limit (listed in `stream_limit_reached`). */
export const ActiveStream = z
  .object({
    playbackSessionId: Id,
    deviceLabel: z.string(),
    titleName: z.string().nullable(),
    startedAt: IsoDateTime,
    lastSeenAt: IsoDateTime,
  })
  .meta({ id: "ActiveStream" });
export type ActiveStream = z.output<typeof ActiveStream>;
