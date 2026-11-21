/**
 * Vite plugin for mock mode: serves procedural SVG artwork at the real `/cdn/img/...` URLs, so
 * the UI exercises its genuine image paths (srcset, sizes, blur-up) without a backend. Active in
 * `vite --mode mock` and `vite preview --mode mock`.
 */
import type { Connect, Plugin } from "vite";
import { type ArtKind, renderArtwork, renderAvatar } from "../src/mocks/artwork.ts";
import { MOCK_TITLES } from "../src/mocks/data/catalog.ts";

const bySlug = new Map(MOCK_TITLES.map((seed) => [seed.slug, seed]));
const TITLE_IMAGE =
  /^\/cdn\/img\/titles\/t-([a-z0-9-]+)\/(backdrop|card|poster|logo)-(\d+)\.(avif|webp)$/;
const EPISODE_STILL =
  /^\/cdn\/img\/episodes\/e-([a-z0-9-]+)-s(\d+)e(\d+)\/still-(\d+)\.(avif|webp)$/;
const AVATAR = /^\/cdn\/img\/avatars\/([A-Za-z0-9_-]+)\.webp$/;

function send(res: Parameters<Connect.NextHandleFunction>[1], svg: string): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(svg);
}

const middleware: Connect.NextHandleFunction = (req, res, next) => {
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (!path.startsWith("/cdn/") && !path.startsWith("/media/")) return next();

  const title = TITLE_IMAGE.exec(path);
  if (title) {
    const seed = bySlug.get(title[1] ?? "");
    if (seed) {
      return send(
        res,
        renderArtwork(
          {
            seed: seed.slug,
            name: seed.name,
            palette: seed.palette,
            motif: seed.motif,
            genre: seed.genres[0] ?? "drama",
            kind: title[2] as ArtKind,
          },
          Number(title[3]),
        ),
      );
    }
  }
  const still = EPISODE_STILL.exec(path);
  if (still) {
    const seed = bySlug.get(still[1] ?? "");
    if (seed) {
      return send(
        res,
        renderArtwork(
          {
            seed: seed.slug,
            name: seed.name,
            palette: seed.palette,
            motif: seed.motif,
            genre: seed.genres[0] ?? "drama",
            kind: "still",
            variant: Number(still[2]) * 100 + Number(still[3]),
          },
          Number(still[4]),
        ),
      );
    }
  }
  const avatar = AVATAR.exec(path);
  if (avatar) return send(res, renderAvatar(avatar[1] ?? "avatar"));

  // Previews and streams do not exist in mock mode: answer like a missing blob.
  res.statusCode = 404;
  res.end();
};

export function mockMediaPlugin(): Plugin {
  return {
    name: "webflix-mock-media",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
