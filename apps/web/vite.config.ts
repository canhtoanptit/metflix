import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
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
 * WEBFLIX_API_ORIGIN (default http://localhost:4000).
 */
export default defineConfig(({ mode, command }) => {
  const mock = mode === "mock";
  // The SPA and the API are always same-origin (blueprint §2.3): in dev, Vite proxies the
  // server-owned prefixes to the API process. Mock mode answers them itself.
  const apiOrigin = process.env.WEBFLIX_API_ORIGIN ?? "http://localhost:4000";
  const proxy = mock
    ? undefined
    : Object.fromEntries(
        ["/api", "/media", "/cdn", "/healthz", "/readyz"].map((prefix) => [
          prefix,
          { target: apiOrigin, changeOrigin: false },
        ]),
      );

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
