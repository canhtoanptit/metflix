/**
 * Transport-level constants shared by the web client, the API and the edge worker.
 * Changing any of these is a breaking change for every deployment mode.
 */

/** Every JSON API route lives under this prefix. Route paths in the route table are relative to it. */
export const API_BASE_PATH = "/api/v1";

/**
 * The staff (admin) API (milestone 2 §8.3). Paths in `adminRoutes` are relative to it. Bearer
 * tokens from the staff issuer, never the member session cookie.
 */
export const ADMIN_API_BASE_PATH = "/api/admin/v1";

/** OpenAPI document and its rendered docs UI (outside the versioned prefix). */
export const OPENAPI_PATH = "/api/openapi.json";
export const API_DOCS_PATH = "/api/docs";

/** Public immutable blobs: `/cdn/<x>` maps to blob key `public/<x>`. */
export const CDN_PATH_PREFIX = "/cdn";
/** Protected streams: `/media/<token>/vod/<assetId>/...` maps to blob key `vod/<assetId>/...`. */
export const MEDIA_PATH_PREFIX = "/media";

/**
 * CSRF defence (blueprint §2.3): every non-safe request must carry this header.
 * Browsers cannot attach custom headers to cross-site form posts, so its presence
 * proves the request came from our own scripts.
 */
export const CLIENT_HEADER = "X-Webflix-Client";
export const CLIENT_HEADER_VALUE = "web";

/** Correlates a request across logs and problem responses. Echoed by the server. */
export const REQUEST_ID_HEADER = "X-Request-Id";

export const JSON_CONTENT_TYPE = "application/json";
export const PROBLEM_CONTENT_TYPE = "application/problem+json";
/** An issuer's `form_post` callback (Apple). */
export const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Methods that never change state and therefore skip the CSRF header check. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}
