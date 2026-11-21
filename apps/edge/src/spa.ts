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
 *   with its revalidating cache headers, ETag and the chart's security headers).
 */

/** Must equal the positive entries of `assets.run_worker_first` (a test checks). */
export const SERVER_PATHS = ["/api/*", "/media/*", "/cdn/*", "/healthz", "/readyz"] as const;

export function isServerPath(pathname: string): boolean {
  return SERVER_PATHS.some((rule) =>
    rule.endsWith("/*") ? pathname.startsWith(rule.slice(0, -1)) : pathname === rule,
  );
}

const EXTENSION = /\.[A-Za-z0-9]{1,10}$/;

/** Build output or a file name: never a client-side route. */
export function isFileLike(pathname: string, navigation: boolean): boolean {
  if (pathname.startsWith("/assets/")) return true;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return EXTENSION.test(last) && !navigation;
}

export function isNavigation(request: Request): boolean {
  return request.headers.get("Sec-Fetch-Mode") === "navigate";
}

export type MissRoute = "app" | "shell";

/** Where a request that reached the Worker goes. */
export function routeRequest(request: Request): MissRoute {
  const { pathname } = new URL(request.url);
  if (isServerPath(pathname)) return "app";
  if (request.method !== "GET" && request.method !== "HEAD") return "app";
  return isFileLike(pathname, isNavigation(request)) ? "app" : "shell";
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
