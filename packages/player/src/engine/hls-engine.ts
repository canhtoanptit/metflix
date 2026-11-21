/**
 * hls.js engine. Loaded with a dynamic import so hls.js, by far the largest dependency, stays
 * out of the initial browse bundle and loads with the watch page (or the first HLS preview).
 *
 * - The plan cap is enforced before the first fragment loads: `autoStartLoad` is off, levels
 *   taller than `maxVideoHeight` are removed on MANIFEST_PARSED, then loading starts at the
 *   resume position. ABR (and `capLevelToPlayerSize`) then only ever sees allowed levels.
 * - Errors go through `classifyHlsError`: network retries with back-off, media recovery (then
 *   with an audio codec swap), and only then a fatal error to the player.
 */
import type Hls from "hls.js";
import type { ErrorData, HlsConfig, Level, MediaPlaylist } from "hls.js";
import { classifyHlsError, type RecoveryBudget } from "../core/errors.ts";
import { levelsAboveCap, primaryLanguage, type QualityLevel } from "../core/tracks.ts";
import type { EngineConfig, EngineEvents, PlaybackEngine } from "./types.ts";

type HlsModule = typeof import("hls.js");

let hlsModule: Promise<HlsModule> | null = null;

/** Load hls.js once per page. */
export function loadHls(): Promise<HlsModule> {
  hlsModule ??= import("hls.js");
  return hlsModule;
}

/** MSE (or ManagedMediaSource) playback is possible. Loads hls.js to ask it. */
export async function isHlsJsSupported(): Promise<boolean> {
  try {
    const { default: HlsClass } = await loadHls();
    return HlsClass.isSupported();
  } catch {
    return false;
  }
}

const MEDIA_RECOVERY_RESET_MS = 10_000;
/** Each nudge of a stuck playhead seeks this much further than the last (hls.js's own step). */
const STALL_NUDGE_SEC = 0.1;

export function defaultHlsConfig(config: EngineConfig): Partial<HlsConfig> {
  return {
    autoStartLoad: false,
    startPosition: config.startPositionSec,
    // Don't fetch 1080p into a 400 px window; fullscreen lifts the cap again.
    capLevelToPlayerSize: true,
    capLevelOnFPSDrop: true,
    // Bound memory on long titles: keep a minute behind the playhead for quick rewinds.
    backBufferLength: 60,
    maxBufferLength: 30,
    enableWorker: true,
    ...config.hlsConfig,
  };
}

export async function createHlsEngine(
  media: HTMLVideoElement,
  config: EngineConfig,
  events: EngineEvents,
): Promise<PlaybackEngine> {
  const { default: HlsClass } = await loadHls();
  const hls: Hls = new HlsClass(defaultHlsConfig(config));
  const { Events } = HlsClass;
  const budget: RecoveryBudget = { networkRetries: 0, mediaRecoveries: 0, stallNudges: 0 };
  let lastMediaRecoveryAt = 0;
  let nudgedTo = 0;
  // A nudge worked once playback really moves on from where it put the playhead.
  const onTimeUpdate = () => {
    if (budget.stallNudges > 0 && media.currentTime > nudgedTo + 0.5) budget.stallNudges = 0;
  };
  media.addEventListener("timeupdate", onTimeUpdate);
  let manifestParsed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const toLevels = (levels: readonly Level[]): QualityLevel[] =>
    levels.map((level, id) => ({
      id,
      width: level.width,
      height: level.height,
      bitrate: level.bitrate,
    }));

  const emitAudio = () => {
    const tracks = hls.audioTracks.map((track: MediaPlaylist, id: number) => ({
      id,
      language: track.lang ?? "",
      name: track.name ?? "",
    }));
    events.audioTracks(tracks, hls.audioTrack >= 0 ? hls.audioTrack : null);
  };

  const pickPreferredAudio = () => {
    const preferred = config.preferredAudioLanguage;
    if (!preferred) return;
    const tracks = hls.audioTracks;
    const exact = tracks.findIndex(
      (track) => track.lang?.toLowerCase() === preferred.toLowerCase(),
    );
    const index =
      exact >= 0
        ? exact
        : tracks.findIndex(
            (track) => primaryLanguage(track.lang ?? "") === primaryLanguage(preferred),
          );
    if (index >= 0 && index !== hls.audioTrack) hls.audioTrack = index;
  };

  hls.on(Events.MANIFEST_PARSED, () => {
    manifestParsed = true;
    for (const index of levelsAboveCap(hls.levels, config.maxVideoHeight)) {
      hls.removeLevel(index);
    }
    events.levels(toLevels(hls.levels), hls.levels.length > 1);
    pickPreferredAudio();
    emitAudio();
    hls.startLoad(config.startPositionSec > 0 ? config.startPositionSec : -1);
  });
  hls.on(Events.LEVELS_UPDATED, (_event, data) => {
    events.levels(toLevels(data.levels), data.levels.length > 1);
  });
  hls.on(Events.LEVEL_SWITCHED, (_event, data) => events.levelSwitched(data.level));
  hls.on(Events.AUDIO_TRACKS_UPDATED, emitAudio);
  hls.on(Events.AUDIO_TRACK_SWITCHED, (_event, data) => events.audioSwitched(data.id));
  hls.on(Events.FRAG_BUFFERED, () => {
    budget.networkRetries = 0;
    if (budget.mediaRecoveries > 0 && Date.now() - lastMediaRecoveryAt > MEDIA_RECOVERY_RESET_MS) {
      budget.mediaRecoveries = 0;
    }
  });
  hls.on(Events.ERROR, (_event, data: ErrorData) => {
    if (destroyed) return;
    const decision = classifyHlsError(data, budget);
    switch (decision.action) {
      case "ignore":
        return;
      case "retry-network":
        budget.networkRetries += 1;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (destroyed) return;
          if (manifestParsed) hls.startLoad(media.currentTime);
          else hls.loadSource(config.url);
        }, decision.delayMs);
        return;
      case "nudge":
        budget.stallNudges += 1;
        nudgedTo = media.currentTime + STALL_NUDGE_SEC * budget.stallNudges;
        media.currentTime = nudgedTo;
        return;
      case "recover-media":
        budget.mediaRecoveries += 1;
        lastMediaRecoveryAt = Date.now();
        if (decision.swapAudioCodec) hls.swapAudioCodec();
        hls.recoverMediaError();
        return;
      case "fatal":
        hls.stopLoad();
        events.fatal({
          code: decision.code,
          detail: data.details,
          httpStatus: decision.httpStatus,
        });
        return;
    }
  });

  hls.attachMedia(media);
  hls.loadSource(config.url);

  return {
    kind: "hls.js",
    setQuality(mode) {
      // nextLevel switches at the next fragment boundary: no flush, no rebuffer.
      hls.nextLevel = mode === "auto" ? -1 : mode;
    },
    setAudioTrack(id) {
      if (id >= 0 && id < hls.audioTracks.length) hls.audioTrack = id;
    },
    destroy() {
      destroyed = true;
      media.removeEventListener("timeupdate", onTimeUpdate);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      hls.destroy();
    },
  };
}
