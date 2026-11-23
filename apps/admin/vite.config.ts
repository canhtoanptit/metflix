import type { IncomingMessage, ServerResponse } from "node:http";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
// The console's production Content-Security-Policy, as the Cloudflare Worker sets it (a file
// with no imports, shared with the Worker's asset staging): the preview serves the bundle under
// it too, so a preview run shows what a deployment would block. Build tooling only: nothing of
// apps/edge reaches the bundle.
import { consoleContentSecurityPolicy } from "../edge/src/console-policy.ts";
import { consoleBase, consoleConfig } from "./server/console-config.ts";

/**
 * The staff console, under its own base path (`/admin/`) on the same origin as the API, the
 * member app and (outside production) the development staff issuer:
 *
 *   vite            dev server (port ADMIN_PORT, default 5174)
 *   vite build      static bundle for the platforms to serve under the base path
 *   vite preview    the bundle (port ADMIN_PORT, default 4174)
 *
 * In dev it is opened through the member app's dev or preview server, which proxies `/admin`
 * here (apps/web/vite.config.ts): the development issuer registers the console's redirect
 * (`{origin}/admin/auth/callback`) for one origin only, WEBFLIX_PUBLIC_ORIGIN, the origin the
 * member app is on. A browser that reaches this server directly is sent to that origin
 * (WEBFLIX_PUBLIC_ORIGIN, default http://localhost:5173, or :4173 for preview); set it to this
 * server's own origin, for the API too, to run the console on its own.
 *
 * The proxy below serves that standalone case: the staff API, the development issuer and the
 * title artwork, at WEBFLIX_API_ORIGIN (default http://localhost:4000).
 *
 * The preview sends the console's production Content-Security-Policy with every response (the
 * dev server can't: its hot reload is inline script).
 */
export default defineConfig(({ isPreview }) => {
  const env = process.env;
  const base = consoleBase(env);
  const config = consoleConfig(env);
  const apiOrigin = env.WEBFLIX_API_ORIGIN ?? "http://localhost:4000";
  const proxy = Object.fromEntries(
    ["/api", "/dev-idp", "/cdn"].map((prefix) => [
      prefix,
      { target: apiOrigin, changeOrigin: false },
    ]),
  );
  const port = Number(env.ADMIN_PORT ?? (isPreview ? 4174 : 5174));
  const publicOrigin = env.WEBFLIX_PUBLIC_ORIGIN ?? `http://localhost:${isPreview ? 4173 : 5173}`;

  return {
    base,
    plugins: [
      react(),
      tailwindcss(),
      consoleConfigFile(base, JSON.stringify(config)),
      onePublicOrigin(base, publicOrigin, port),
      productionPolicy(consoleContentSecurityPolicy(config.issuer)),
    ],
    server: { port, strictPort: true, proxy },
    preview: { port, strictPort: true, proxy },
    build: { outDir: "dist", sourcemap: true, manifest: true },
    test: { environment: "jsdom", setupFiles: ["./test/setup.ts"] },
  };
});

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

/**
 * `config.json` next to `index.html`: answered by the dev server from the environment, written
 * once by the build. Never cached: a platform may replace it without rebuilding.
 */
function consoleConfigFile(base: string, body: string): Plugin {
  const path = `${base}config.json`;
  const answer: Middleware = (request, response, next) => {
    if (request.url?.split("?")[0] !== path) return next();
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.end(body);
  };
  return {
    name: "webflix-admin-config",
    configureServer: (server) => void server.middlewares.use(answer),
    configurePreviewServer: (server) => void server.middlewares.use(answer),
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "config.json", source: body });
    },
  };
}

/**
 * A page opened on this server's own port is sent to the public origin, where the member app's
 * server proxies `/admin` here: signing in only works there (the issuer's one registered
 * origin). Requests that arrive through that proxy keep the public Host and pass untouched, and
 * so does a server whose own origin is the public one (the console run on its own).
 */
function onePublicOrigin(base: string, publicOrigin: string, port: number): Plugin {
  const publicHost = new URL(publicOrigin).host;
  const ownHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const redirect: Middleware = (request, response, next) => {
    const host = request.headers.host ?? "";
    const navigation =
      request.method === "GET" && (request.headers.accept ?? "").includes("text/html");
    if (host === publicHost || !ownHosts.has(host) || !navigation) return next();
    response.statusCode = 302;
    response.setHeader(
      "Location",
      `${publicOrigin}${request.url?.startsWith(base) ? request.url : base}`,
    );
    response.end();
  };
  return {
    name: "webflix-admin-public-origin",
    configureServer: (server) => void server.middlewares.use(redirect),
    configurePreviewServer: (server) => void server.middlewares.use(redirect),
  };
}

/** The console's Content-Security-Policy on everything the preview serves, as in production. */
function productionPolicy(policy: string): Plugin {
  const header: Middleware = (_request, response, next) => {
    response.setHeader("Content-Security-Policy", policy);
    next();
  };
  return {
    name: "webflix-admin-production-policy",
    configurePreviewServer: (server) => void server.middlewares.use(header),
  };
}
