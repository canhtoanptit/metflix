/**
 * `/media/<token>/...` → `/media/:token/...`: media tokens never reach logs or metric labels.
 * Every log line that carries a request path passes it through here.
 */
export function redactPath(path: string): string {
  return path.startsWith("/media/") ? path.replace(/^\/media\/[^/]+/, "/media/:token") : path;
}
