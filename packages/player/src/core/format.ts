/**
 * Player clock format: `m:ss` under an hour, `h:mm:ss` above. Negative and non-finite input
 * renders as `0:00` (media elements report NaN before metadata loads).
 */
export function formatPlaybackTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

/** Remaining time as shown next to the scrubber: `-12:34`. Never negative. */
export function formatRemainingTime(currentSec: number, durationSec: number): string {
  const remaining = Math.max(0, (Number.isFinite(durationSec) ? durationSec : 0) - currentSec);
  // Ceil so the clock reads 0:00 only at the very end, like a countdown.
  return `-${formatPlaybackTime(Math.ceil(remaining - 1e-6))}`;
}

/**
 * Spoken form for `aria-valuetext` and announcements: "1 hour 2 minutes 5 seconds".
 * Screen readers read "1:02:05" inconsistently, so sliders use this instead.
 */
export function formatSpokenDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs} ${secs === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}

/** Episode runtime label: "45m", "1h 5m", "52s" for very short clips. */
export function formatRuntime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** "S1:E3" — the compact episode code used in the title label and panels. */
export function formatEpisodeCode(seasonNumber: number, episodeNumber: number): string {
  return `S${seasonNumber}:E${episodeNumber}`;
}

/** "1.25×", "Normal" for 1. */
export function formatRate(rate: number, normalLabel = "Normal"): string {
  if (rate === 1) return normalLabel;
  return `${Number(rate.toFixed(2))}×`;
}

/** "4.2 Mbps" / "800 kbps" for quality menus. */
export function formatBitrate(bitsPerSecond: number): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return "";
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}
