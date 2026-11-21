import type { EngineKind, EnginePreference } from "../core/engine-choice.ts";
import { chooseEngine } from "../core/engine-choice.ts";
import { createHlsEngine, isHlsJsSupported } from "./hls-engine.ts";
import { createNativeEngine } from "./native-engine.ts";
import type { EngineFactory } from "./types.ts";

export const HLS_MIME = "application/vnd.apple.mpegurl";

/** Detect capabilities and pick the engine for a URL (see `chooseEngine`). */
export async function resolveEngineKind(
  url: string,
  preference: EnginePreference,
  media: HTMLMediaElement,
): Promise<EngineKind | null> {
  const nativeHls = media.canPlayType(HLS_MIME) !== "";
  // Only pay for the hls.js download when the URL is HLS and hls.js could be chosen.
  const needsMse = /\.m3u8(?:[?#]|$)/i.test(url) && !(preference === "native" && nativeHls);
  const mse = needsMse ? await isHlsJsSupported() : false;
  return chooseEngine(url, preference, { mse, nativeHls });
}

export const defaultEngineFactory: EngineFactory = async (kind, media, config, events) => {
  if (kind === "hls.js") return createHlsEngine(media, config, events);
  return createNativeEngine(kind, media, config, events);
};
