/**
 * Playback errors: the public `PlayerError` shape and the recovery policy for hls.js errors.
 * The policy is pure so the retry / recover / give-up ladder is unit-tested.
 */

export type PlayerErrorCode =
  /** Network failure that survived the retries (or the device is offline). */
  | "network"
  /** 401/403 from the media origin: the signed media token expired or was revoked. */
  | "forbidden"
  /** 404/410 for the manifest. */
  | "not_found"
  /** Decode/append failure that survived media recovery. */
  | "media"
  /** No playback path for this source in this browser, or unsupported codecs. */
  | "unsupported"
  | "unknown";

export interface PlayerError {
  code: PlayerErrorCode;
  /** Developer-facing detail (engine error name). Not for display. */
  detail: string;
  httpStatus: number | null;
  /** Where playback was when it failed; resume a recreated session from here. */
  positionSec: number;
  /** Always true: recoverable errors are handled inside the player and never surfaced. */
  fatal: true;
}

/** Minimal view of hls.js `ErrorData` the policy needs. */
export interface HlsErrorLike {
  type: string;
  details: string;
  fatal: boolean;
  response?: { code?: number | undefined } | undefined;
  networkDetails?: unknown;
  /** `bufferStalledError`: seconds buffered ahead of the stuck playhead. */
  buffer?: number | undefined;
}

export interface RecoveryBudget {
  networkRetries: number;
  mediaRecoveries: number;
  /** Nudges spent on the current stuck playhead (reset once playback really advances). */
  stallNudges: number;
}

export const MAX_NETWORK_RETRIES = 3;
export const MAX_MEDIA_RECOVERIES = 2;
export const MAX_STALL_NUDGES = 3;
/** Buffered ahead of a stuck playhead that makes it a stuck pipeline rather than starvation. */
export const STALLED_WITH_DATA_SEC = 1;

export type RecoveryAction =
  | { action: "ignore" }
  | { action: "retry-network"; delayMs: number }
  /** Seek a hair forward: flushes a decoding pipeline that stopped with data buffered. */
  | { action: "nudge" }
  | { action: "recover-media"; swapAudioCodec: boolean }
  | { action: "fatal"; code: PlayerErrorCode; httpStatus: number | null };

const MANIFEST_DETAILS = new Set(["manifestLoadError", "manifestLoadTimeOut"]);

export function httpStatusOf(error: HlsErrorLike): number | null {
  const code = error.response?.code;
  if (typeof code === "number" && code > 0) return code;
  const xhr = error.networkDetails as { status?: unknown } | undefined;
  return typeof xhr?.status === "number" && xhr.status > 0 ? xhr.status : null;
}

/** Back-off for network retries: 1 s, 2 s, 4 s. */
export function retryDelayMs(attempt: number): number {
  return 1000 * 2 ** Math.max(0, attempt);
}

export function classifyHlsError(error: HlsErrorLike, budget: RecoveryBudget): RecoveryAction {
  const status = httpStatusOf(error);
  // Expired or revoked tokens never heal by retrying: surface immediately so the host can
  // create a new session even if hls.js would have treated the failure as non-fatal.
  if (status === 401 || status === 403) {
    return { action: "fatal", code: "forbidden", httpStatus: status };
  }
  if (!error.fatal) {
    // hls.js reports a stuck playhead once per stall, and nudges it only across buffer holes.
    // Stuck inside one buffered range with seconds of data ahead (Firefox and WebKit, right
    // after the start-gap seek) nothing else would ever move it: the member sees a frozen frame.
    if (error.details === "bufferStalledError" && (error.buffer ?? 0) >= STALLED_WITH_DATA_SEC) {
      if (budget.stallNudges < MAX_STALL_NUDGES) return { action: "nudge" };
      if (budget.mediaRecoveries < MAX_MEDIA_RECOVERIES) {
        return { action: "recover-media", swapAudioCodec: false };
      }
    }
    return { action: "ignore" };
  }
  if (error.type === "networkError") {
    if ((status === 404 || status === 410) && MANIFEST_DETAILS.has(error.details)) {
      return { action: "fatal", code: "not_found", httpStatus: status };
    }
    if (budget.networkRetries < MAX_NETWORK_RETRIES) {
      return { action: "retry-network", delayMs: retryDelayMs(budget.networkRetries) };
    }
    return { action: "fatal", code: "network", httpStatus: status };
  }
  if (error.type === "mediaError") {
    if (error.details === "manifestIncompatibleCodecsError") {
      return { action: "fatal", code: "unsupported", httpStatus: null };
    }
    if (budget.mediaRecoveries < MAX_MEDIA_RECOVERIES) {
      return { action: "recover-media", swapAudioCodec: budget.mediaRecoveries > 0 };
    }
    return { action: "fatal", code: "media", httpStatus: null };
  }
  if (error.type === "muxError") return { action: "fatal", code: "media", httpStatus: null };
  return { action: "fatal", code: "unknown", httpStatus: status };
}

/** `HTMLMediaElement.error.code` → player error code (null: not an error worth surfacing). */
export function classifyMediaElementError(code: number): PlayerErrorCode | null {
  switch (code) {
    case 1: // MEDIA_ERR_ABORTED: the source was swapped or unloaded on purpose.
      return null;
    case 2:
      return "network";
    case 3:
      return "media";
    case 4:
      return "unsupported";
    default:
      return "unknown";
  }
}
