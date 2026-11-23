/**
 * What the Worker does with requests the static-asset layer did not answer.
 *
 * wrangler.jsonc sends the server-owned prefixes to the Worker first (`run_worker_first`) and
 * uses `not_found_handling: "none"`, so every other request that matches no file also reaches
 * the Worker. The asset layer's own SPA mode would answer those with `index.html` and status
 * 200, under whatever `_headers` rule matches the path: a chunk a new deploy no longer has
 * (`/assets/index-<old hash>.js`) would come back as HTML marked immutable for a year, in the
 * browser and any shared cache, and a rollback would not heal it. Here instead:
 *
 * - server paths go to the HTTP app;
 * - file-like misses (anything under `/assets/`, or a last segment with an extension that is
 *   not a navigation) are a 404 problem document with `no-store`;
 * - everything else is a client-side route: the SPA shell (`index.html` from the asset layer,
 *   with its revalidating cache headers, ETag and the chart's security headers);
 * - except under `/admin/`, the staff console (apps/admin, staged there beside the member app):
 *   its own client-side routes get the console's `index.html` (the asset layer knows only one
 *   SPA index), never cached; a missing `/admin/assets/*` file is a 404 like any build file.
 *   `/admin/config.json` is the Worker's (`admin-console.ts`).
 */

/** Must equal the positive entries of `assets.run_worker_first` (a test checks). */
export const SERVER_PATHS = [
  "/api/*",
  "/media/*",
  "/cdn/*",
  "/healthz",
  "/readyz",
  // Milestone 2: the development issuer (not in production) and the fake provider's payment
  // form (`/_pay/*`, billing area) are served by the Worker, never the SPA shell.
  "/dev-idp/*",
  "/_pay/*",
  // The staff console's settings, from the Worker's own staff configuration (admin-console.ts).
  "/admin/config.json",
] as const;

/** Where the staff console's build is staged and served (apps/admin's `base`). */
export const CONSOLE_BASE = "/admin/";

export function isConsolePath(pathname: string): boolean {
  return pathname.startsWith(CONSOLE_BASE);
}

export function isServerPath(pathname: string): boolean {
  return SERVER_PATHS.some((rule) =>
    rule.endsWith("/*") ? pathname.startsWith(rule.slice(0, -1)) : pathname === rule,
  );
}

const EXTENSION = /\.[A-Za-z0-9]{1,10}$/;

/** Build output or a file name: never a client-side route. */
export function isFileLike(pathname: string, navigation: boolean): boolean {
  if (pathname.startsWith("/assets/") || pathname.startsWith(`${CONSOLE_BASE}assets/`)) return true;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return EXTENSION.test(last) && !navigation;
}

export function isNavigation(request: Request): boolean {
  return request.headers.get("Sec-Fetch-Mode") === "navigate";
}

export type MissRoute = "app" | "shell" | "console";

/** Where a request that reached the Worker goes. */
export function routeRequest(request: Request): MissRoute {
  const { pathname } = new URL(request.url);
  if (isServerPath(pathname)) return "app";
  if (request.method !== "GET" && request.method !== "HEAD") return "app";
  if (isFileLike(pathname, isNavigation(request))) return "app";
  return isConsolePath(pathname) ? "console" : "shell";
}

/**
 * The SPA shell for a client-side route: `/` from the asset layer, which applies the chart's
 * security headers (`_headers`) and answers conditional requests with 304.
 */
export async function serveShell(request: Request, assets: Fetcher): Promise<Response> {
  const headers = new Headers();
  for (const name of ["If-None-Match", "If-Modified-Since", "Accept-Encoding"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return assets.fetch(new Request(new URL("/", request.url), { method: request.method, headers }));
}

/**
 * The staff console's `index.html` for one of its client-side routes (`/admin/members/…`): the
 * asset layer's `/admin/` (its `index.html`, with the security headers of `_headers`), under the
 * console's own Content-Security-Policy (`policy`, set here as well: Cloudflare does not promise
 * `_headers` on what a Worker returns), never cached by anyone, so a deploy's new console is the
 * one every navigation loads.
 */
export async function serveConsoleShell(
  request: Request,
  assets: Fetcher,
  policy: string,
): Promise<Response> {
  const response = await assets.fetch(
    new Request(new URL(CONSOLE_BASE, request.url), { method: request.method }),
  );
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", policy);
  headers.delete("ETag");
  return new Response(response.body, { status: response.status, headers });
}
