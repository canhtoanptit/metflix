/** Request parsing and response building shared by the endpoints. Web-standard APIs only. */

/** The headers every response carries. Pages add their own Content-Security-Policy. */
function baseHeaders(): Headers {
  return new Headers({
    "X-Content-Type-Options": "nosniff",
    // Authorisation requests carry state, nonce and PKCE challenges in the URL: never leak them.
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
    "Cache-Control": "no-store",
  });
}

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string>; cacheSec?: number } = {},
): Response {
  const headers = baseHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Content-Security-Policy", API_CSP);
  if (init.cacheSec !== undefined) headers.set("Cache-Control", `public, max-age=${init.cacheSec}`);
  else headers.set("Pragma", "no-cache");
  for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

/** An OAuth 2.0 error response body (RFC 6749 §5.2). */
export function oauthError(
  status: number,
  error: string,
  description: string,
  headers: Record<string, string> = {},
): Response {
  return json({ error, error_description: description }, { status, headers });
}

export interface PageResponse {
  status?: number;
  body: string;
  csp: string;
  cookies?: readonly string[];
}

export function page(response: PageResponse): Response {
  const headers = baseHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", response.csp);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  for (const cookie of response.cookies ?? []) headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status ?? 200, headers });
}

export function redirect(
  location: string,
  status: 302 | 303,
  cookies: readonly string[] = [],
): Response {
  const headers = baseHeaders();
  headers.set("Location", location);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}

export function notFound(): Response {
  return json({ error: "not_found", error_description: "No such endpoint" }, { status: 404 });
}

export function methodNotAllowed(allow: readonly string[]): Response {
  return json(
    { error: "method_not_allowed", error_description: `Use ${allow.join(" or ")}` },
    { status: 405, headers: { Allow: allow.join(", ") } },
  );
}

// --- Cookies -----------------------------------------------------------------------------------

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export interface CookieOptions {
  path: string;
  secure: boolean;
  sameSite: "Strict" | "Lax";
  /** Seconds; 0 deletes the cookie. */
  maxAge: number;
}

/** Values are base64url or empty, so they need no quoting or encoding. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    "HttpOnly",
    `SameSite=${options.sameSite}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

// --- Forms -------------------------------------------------------------------------------------

export const MAX_FORM_BYTES = 32 * 1024;

export type FormResult =
  | { ok: true; params: URLSearchParams }
  | { ok: false; reason: "unsupported_media_type" | "too_large" | "malformed" };

/** Reads an `application/x-www-form-urlencoded` body of at most `MAX_FORM_BYTES`. */
export async function readForm(request: Request): Promise<FormResult> {
  const type = request.headers.get("Content-Type") ?? "";
  if (type.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    return { ok: false, reason: "unsupported_media_type" };
  }
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_FORM_BYTES) return { ok: false, reason: "too_large" };
  if (!request.body) return { ok: true, params: new URLSearchParams() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORM_BYTES) {
      await reader.cancel();
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      params: new URLSearchParams(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
      ),
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** The first parameter that appears more than once (RFC 6749 §3.1: none may). */
export function duplicateParameter(params: URLSearchParams): string | undefined {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return undefined;
}

/** A parameter's value; empty values count as absent (RFC 6749 §3.1). */
export function param(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name);
  return value === null || value === "" ? undefined : value;
}

// --- CORS --------------------------------------------------------------------------------------

/** Adds CORS headers for a credential-less request from `origin` (never with cookies). */
export function withCors(response: Response, origin: string | "*"): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Expose-Headers", "WWW-Authenticate");
  if (origin !== "*") headers.append("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

export function preflight(origin: string, methods: readonly string[]): Response {
  const headers = baseHeaders();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", methods.join(", "));
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  headers.append("Vary", "Origin");
  return new Response(null, { status: 204, headers });
}

/** Resolves after `ms` (fault `jwksSlow`). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
