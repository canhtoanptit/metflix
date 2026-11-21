/**
 * Player playground: `pnpm --filter @webflix/player playground` → http://localhost:4300.
 *
 * Serves the generated test media (`pnpm --filter @webflix/player media`) with the production
 * URL shapes (blueprint §2.4/§2.5): `/media/{token}/vod/{assetId}/…` and `/cdn/…`. The token
 * `expired` answers 403 to exercise the player's expired-session path.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const MEDIA_ROOT = resolve(import.meta.dirname, "../.cache/test-media");
const PORT = Number(process.env.PLAYER_PLAYGROUND_PORT ?? 4300);

const TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".vtt": "text/vtt; charset=utf-8",
  ".webp": "image/webp",
  ".json": "application/json",
};

function sendFile(req: IncomingMessage, res: ServerResponse, file: string): void {
  const { size } = statSync(file);
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-cache");
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.setHeader("Content-Length", String(size));
  createReadStream(file).pipe(res);
}

function testMedia(): Plugin {
  return {
    name: "webflix-player-test-media",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        let key: string | null = null;
        const media = /^\/media\/([^/]+)\/(vod\/.+)$/.exec(url.pathname);
        if (media) {
          if (media[1] === "expired") {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/problem+json");
            res.end(JSON.stringify({ code: "media_token_expired", status: 403 }));
            return;
          }
          key = media[2] ?? null;
        } else if (url.pathname.startsWith("/cdn/")) {
          key = `public/${url.pathname.slice("/cdn/".length)}`;
        } else if (url.pathname === "/test-media/assets.json") {
          key = "assets.json";
        }
        if (!key) {
          next();
          return;
        }
        const file = normalize(join(MEDIA_ROOT, decodeURIComponent(key)));
        if (!file.startsWith(MEDIA_ROOT) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end("Not found. Run `pnpm --filter @webflix/player media` first.");
          return;
        }
        sendFile(req, res, file);
      });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), testMedia()],
  server: { port: PORT, strictPort: true, host: "localhost" },
  preview: { port: PORT, strictPort: true },
});
