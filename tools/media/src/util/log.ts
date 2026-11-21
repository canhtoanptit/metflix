/**
 * Console progress for long pipeline runs: one line per event, prefixed with elapsed time.
 * `WEBFLIX_MEDIA_QUIET=1` silences info lines (tests); warnings and errors always print.
 */
const started = Date.now();
const quiet = () => process.env.WEBFLIX_MEDIA_QUIET === "1";

function stamp(): string {
  const seconds = (Date.now() - started) / 1000;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

export const log = {
  info(message: string): void {
    if (!quiet()) console.log(`[${stamp()}] ${message}`);
  },
  warn(message: string): void {
    console.warn(`[${stamp()}] warning: ${message}`);
  },
  error(message: string): void {
    console.error(`[${stamp()}] error: ${message}`);
  },
};

/** Time an async step and log its duration. */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  log.info(`${label}…`);
  const result = await fn();
  log.info(`${label} done in ${formatDuration(Date.now() - start)}`);
  return result;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
