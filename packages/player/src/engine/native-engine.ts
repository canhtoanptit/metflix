/**
 * Native engine: the browser plays the URL itself. Used for native HLS where MSE is missing
 * (older iOS) and for progressive files (preview clips). Renditions are chosen by the browser,
 * so the quality menu is hidden and the plan cap cannot be enforced client-side here (the
 * server should also filter the master playlist; see README "Browser support").
 */
import type { EngineKind } from "../core/engine-choice.ts";
import { primaryLanguage } from "../core/tracks.ts";
import type { EngineConfig, EngineEvents, PlaybackEngine } from "./types.ts";

/** Safari's `HTMLMediaElement.audioTracks` (absent from the standard DOM typings). */
interface NativeAudioTrack {
  enabled: boolean;
  language: string;
  label: string;
}
interface NativeAudioTrackList extends EventTarget {
  readonly length: number;
  [index: number]: NativeAudioTrack | undefined;
}

function audioTrackList(media: HTMLMediaElement): NativeAudioTrackList | null {
  const list = (media as HTMLMediaElement & { audioTracks?: NativeAudioTrackList }).audioTracks;
  return list && typeof list.length === "number" ? list : null;
}

export function createNativeEngine(
  kind: Extract<EngineKind, "native" | "progressive">,
  media: HTMLVideoElement,
  config: EngineConfig,
  events: EngineEvents,
): PlaybackEngine {
  const abort = new AbortController();
  const { signal } = abort;

  const readAudio = () => {
    const list = audioTrackList(media);
    if (!list) return;
    const tracks = [];
    let active: number | null = null;
    for (let i = 0; i < list.length; i++) {
      const track = list[i];
      if (!track) continue;
      tracks.push({ id: i, language: track.language, name: track.label });
      if (track.enabled) active = i;
    }
    events.audioTracks(tracks, active);
  };

  const pickPreferredAudio = () => {
    const list = audioTrackList(media);
    const preferred = config.preferredAudioLanguage;
    if (!list || !preferred) return;
    for (let i = 0; i < list.length; i++) {
      const track = list[i];
      if (track && primaryLanguage(track.language) === primaryLanguage(preferred)) {
        for (let j = 0; j < list.length; j++) {
          const other = list[j];
          if (other) other.enabled = j === i;
        }
        return;
      }
    }
  };

  media.addEventListener(
    "loadedmetadata",
    () => {
      if (config.startPositionSec > 0) media.currentTime = config.startPositionSec;
      pickPreferredAudio();
      readAudio();
    },
    { once: true, signal },
  );
  audioTrackList(media)?.addEventListener("change", readAudio, { signal });
  audioTrackList(media)?.addEventListener("addtrack", readAudio, { signal });

  events.levels([], false);
  media.src = config.url;

  return {
    kind,
    setQuality() {
      // The browser owns rendition selection on this path.
    },
    setAudioTrack(id) {
      const list = audioTrackList(media);
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        const track = list[i];
        if (track) track.enabled = i === id;
      }
      readAudio();
    },
    destroy() {
      abort.abort();
    },
  };
}
