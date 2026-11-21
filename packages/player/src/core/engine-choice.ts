/**
 * Which playback path to use. Pure: capabilities are detected by the caller.
 *
 * hls.js (MSE, or ManagedMediaSource on iOS 17.1+) is preferred wherever it runs: it is the
 * only path that can enforce the plan's `maxVideoHeight`, offer a quality menu and recover
 * from network/media errors. Native HLS is the fallback for browsers without MSE (older iOS).
 * `canPlayType` alone cannot decide: recent desktop Chrome answers "maybe" for HLS too.
 */

export type EnginePreference = "auto" | "hls.js" | "native";
export type EngineKind = "hls.js" | "native" | "progressive";

export interface EngineCapabilities {
  /** `Hls.isSupported()`: MSE or ManagedMediaSource with H.264 support. */
  mse: boolean;
  /** `video.canPlayType("application/vnd.apple.mpegurl") !== ""`. */
  nativeHls: boolean;
}

export function isHlsUrl(url: string): boolean {
  const path = url.split(/[?#]/)[0] ?? "";
  return /\.m3u8$/i.test(path);
}

export function chooseEngine(
  url: string,
  preference: EnginePreference,
  caps: EngineCapabilities,
): EngineKind | null {
  if (!isHlsUrl(url)) return "progressive";
  if (preference === "native") return caps.nativeHls ? "native" : caps.mse ? "hls.js" : null;
  if (preference === "hls.js") return caps.mse ? "hls.js" : caps.nativeHls ? "native" : null;
  if (caps.mse) return "hls.js";
  if (caps.nativeHls) return "native";
  return null;
}
