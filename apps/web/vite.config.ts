import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { ProxyOptions } from "vite";
import { defineConfig } from "vitest/config";
import { fontPreloadPlugin } from "./mock-server/font-preload.ts";
import { mockMediaPlugin } from "./mock-server/mock-media.ts";

/**
 * Modes:
 *   vite                 dev against a real API (same origin via the proxy below)
 *   vite --mode mock     no backend: API answered in the browser, artwork generated
 *   vite build           production bundle (mock code and dev tools removed)
 *   vite build --mode mock   a static mock build for e2e and screenshots
 *
 * Ports: WEB_PORT (default 5173 for dev, 4173 for preview); the API origin is
 * WEBFLIX_API_ORIGIN (default http://localhost:4000); the staff console, served at /admin/ on
 * this origin, is WEBFLIX_ADMIN_ORIGIN (default http://localhost:5174, or :4174 for preview).
 */
type ProxyServer = Parameters<NonNullable<ProxyOptions["configure"]>>[0];

/** When the console's server is not running, say how to start it instead of a bare 502. */
function explainMissingConsole(server: ProxyServer, preview: boolean): void {
  server.on("error", (_error, _request, response) => {
    if (!("writeHead" in response) || response.headersSent) return;
    const start = preview
      ? "pnpm --filter @webflix/admin build && pnpm --filter @webflix/admin preview"
      : "pnpm --filter @webflix/admin dev (pnpm dev starts it with the API and this app)";
    response.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><title>Staff console not running</title><body style="font:16px system-ui;margin:3rem;background:#0b0c0f;color:#f4f2ee"><h1>The staff console isn't running</h1><p>This server proxies <code>/admin</code> to it. Start it with <code>${start}</code>, then reload.</p></body>`,
    );
  });
}

export default defineConfig(({ mode, command, isPreview }) => {
  const mock = mode === "mock";
  // The SPA and the API are always same-origin (blueprint §2.3): in dev, Vite proxies the
  // server-owned prefixes to the API process. Mock mode answers them itself.
  // Outside production the API also serves the development sign-in issuer (`/dev-idp/*`: the
  // stand-in for Google, Apple and the staff realm) and the fake payment provider's form
  // (`/_pay/*`). A browser reaches both through this origin, so the API must be started with
  // WEBFLIX_PUBLIC_ORIGIN set to the dev server's origin (the issuer and the callbacks are built
  // from it). Apple's callback is a form post back to `/api`, which the same entry carries.
  const apiOrigin = process.env.WEBFLIX_API_ORIGIN ?? "http://localhost:4000";
  // The staff console (apps/admin) lives under /admin on this same origin, as the deployments
  // serve it: proxied to its own dev or preview server, websockets included (its hot reload).
  // One origin is what the development staff issuer needs: it registers the console's redirect
  // for WEBFLIX_PUBLIC_ORIGIN only. WEBFLIX_ADMIN_ORIGIN, default :5174 (dev) or :4174 (preview).
  const adminOrigin =
    process.env.WEBFLIX_ADMIN_ORIGIN ?? `http://localhost:${isPreview ? 4174 : 5174}`;
  const proxy = mock
    ? undefined
    : {
        ...Object.fromEntries(
          ["/api", "/media", "/cdn", "/healthz", "/readyz", "/dev-idp", "/_pay"].map((prefix) => [
            prefix,
            { target: apiOrigin, changeOrigin: false },
          ]),
        ),
        "/admin": {
          target: adminOrigin,
          changeOrigin: false,
          ws: true,
          configure: (server: ProxyServer) => explainMissingConsole(server, isPreview === true),
        },
      };

  return {
    // Build-time flags (declared in src/app/env.ts). Replaced at each use so dead code is dropped.
    define: {
      __WEBFLIX_MOCK__: JSON.stringify(mock),
      __WEBFLIX_DEVTOOLS__: JSON.stringify(mock || command === "serve"),
    },
    plugins: [react(), tailwindcss(), fontPreloadPlugin(), mock ? mockMediaPlugin() : null],
    server: {
      port: Number(process.env.WEB_PORT ?? 5173),
      strictPort: true,
      proxy,
    },
    preview: { port: Number(process.env.WEB_PORT ?? 4173), strictPort: true, proxy },
    build: {
      outDir: mock ? "dist-mock" : "dist",
      sourcemap: true,
      // Chunk graph for bundle budgets (see docs/DESIGN_SYSTEM.md "Bundle").
      manifest: true,
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./test/setup.ts"],
    },
  };
});
