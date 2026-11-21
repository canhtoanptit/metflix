import { blobKeyForCdnPath, blobKeys, parseMediaPath } from "@webflix/contracts";
import {
  AppError,
  type BlobMetadata,
  type BlobRange,
  BlobRangeNotSatisfiableError,
  capMasterPlaylist,
  parseHttpRange,
  renditionsAboveCap,
} from "@webflix/core";
import type { Context, Hono } from "hono";
import type { AppContainer, AppEnv } from "./container.ts";

type AppContext = Context<AppEnv>;

const IMMUTABLE = "public, max-age=31536000, immutable";
/** Upper bound for caching protected media in the browser (it also may not outlive the token). */
const MEDIA_MAX_AGE_SEC = 3600;

/** Strips `W/` and splits a header like `"a", W/"b"` into opaque tags. */
function entityTags(header: string): string[] {
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .filter((tag) => tag !== "");
}

/** RFC 9110 §13.1.2: weak comparison for If-None-Match. */
function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const tags = entityTags(header);
  return tags.includes(etag.replace(/^W\//, ""));
}

/** If-Range uses strong comparison; a date or a weak tag never matches. */
function ifRangeAllows(header: string | undefined, etag: string): boolean {
  if (!header) return true;
  return !header.startsWith("W/") && header.trim() === etag;
}

function quoted(etag: string): string {
  return `"${etag}"`;
}

function validators(meta: BlobMetadata, etag: string): Record<string, string> {
  return {
    ETag: etag,
    "Last-Modified": new Date(meta.uploadedAt).toUTCString(),
    "Content-Type": meta.contentType,
  };
}

/**
 * Serve one blob: conditional requests (If-None-Match → 304), single byte ranges (206 with
 * Content-Range; 416 when unsatisfiable; If-Range falls back to the full object), HEAD without
 * opening the body.
 */
async function serveBlob(
  container: AppContainer,
  c: AppContext,
  key: string,
  cacheControl: string,
): Promise<Response> {
  const head = c.req.method === "HEAD";
  const ifNoneMatch = c.req.header("If-None-Match");
  // Conditional and HEAD requests only need metadata: no body is opened for them.
  if (head || ifNoneMatch) {
    const meta = await container.blobs.head(key);
    if (!meta) throw new AppError("not_found", { detail: "No such file" });
    const etag = quoted(meta.etag);
    const common = {
      ...validators(meta, etag),
      "Cache-Control": cacheControl,
      "Accept-Ranges": "bytes",
    };
    if (matchesIfNoneMatch(ifNoneMatch, etag)) return c.body(null, 304, common);
    if (head) return c.body(null, 200, { ...common, "Content-Length": String(meta.size) });
  }

  const requested = parseHttpRange(c.req.header("Range"));
  let range: BlobRange | undefined;
  if (requested) range = requested;
  let object: Awaited<ReturnType<typeof container.blobs.get>>;
  try {
    object = await container.blobs.get(key, range ? { range } : {});
  } catch (error) {
    if (error instanceof BlobRangeNotSatisfiableError) {
      c.header("Content-Range", `bytes */${error.size}`);
      throw new AppError("range_not_satisfiable", { size: error.size });
    }
    throw error;
  }
  if (!object) throw new AppError("not_found", { detail: "No such file" });
  const etag = quoted(object.etag);

  // If-Range: the client's cached copy is stale, so send the whole (new) object instead.
  if (object.range && !ifRangeAllows(c.req.header("If-Range"), etag)) {
    await object.body.cancel();
    const full = await container.blobs.get(key);
    if (!full) throw new AppError("not_found", { detail: "No such file" });
    object = full;
  }

  const headers: Record<string, string> = {
    ...validators(object, etag),
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
  };
  if (object.range) {
    const end = object.range.offset + object.range.length - 1;
    headers["Content-Range"] = `bytes ${object.range.offset}-${end}/${object.size}`;
    headers["Content-Length"] = String(object.range.length);
    return c.body(object.body, 206, headers);
  }
  headers["Content-Length"] = String(object.size);
  return c.body(object.body, 200, headers);
}

/** Master playlists are rewritten to the plan's rendition cap; never ranged, never stored by caches. */
async function servePlaylist(
  container: AppContainer,
  c: AppContext,
  key: string,
  maxVideoHeight: number,
): Promise<Response> {
  const object = await container.blobs.get(key);
  if (!object) throw new AppError("not_found", { detail: "No such file" });
  const text = capMasterPlaylist(await new Response(object.body).text(), maxVideoHeight);
  // The representation depends on the cap, so the validator does too.
  const etag = `W/"${object.etag}-h${maxVideoHeight}"`;
  const headers = {
    ...validators(object, etag),
    "Cache-Control": "private, no-cache",
  };
  if (matchesIfNoneMatch(c.req.header("If-None-Match"), etag)) return c.body(null, 304, headers);
  const bytes = new TextEncoder().encode(text);
  const sized = { ...headers, "Content-Length": String(bytes.byteLength) };
  return c.req.method === "HEAD" ? c.body(null, 200, sized) : c.body(text, 200, sized);
}

/** How long a process trusts what it read from an asset's master playlist. */
const RENDITION_MAP_TTL_MS = 10 * 60 * 1000;
const RENDITION_MAP_MAX_ENTRIES = 1000;

/**
 * The rendition directories of an asset above a height cap, read from its master playlist and
 * kept in memory for a while: segment requests are checked against the token's cap without a
 * database read. The first segment of an asset in a process (an isolate on Workers) costs one
 * extra blob read, the master; later ones none, for ten minutes. Only settled results are kept:
 * a read in flight is never shared with another request (on Workers a promise created by one
 * request must not be awaited by another), so concurrent first requests each read.
 */
function createRenditionCaps(container: AppContainer) {
  const memo = new Map<string, { refused: string[]; until: number }>();
  return async (assetId: string, maxVideoHeight: number): Promise<string[]> => {
    const key = `${assetId}@${maxVideoHeight}`;
    const cached = memo.get(key);
    if (cached && cached.until > container.clock.now()) return cached.refused;
    const master = await container.blobs.get(blobKeys.vodMaster(assetId));
    const refused = master
      ? renditionsAboveCap(await new Response(master.body).text(), maxVideoHeight).map(
          (directory) => `${blobKeys.vodPrefix(assetId)}${directory}`,
        )
      : [];
    if (memo.size >= RENDITION_MAP_MAX_ENTRIES) memo.clear();
    memo.set(key, { refused, until: container.clock.now() + RENDITION_MAP_TTL_MS });
    return refused;
  };
}

/**
 * `/cdn/*` (public, immutable: artwork, avatars, previews) and `/media/{token}/vod/...`
 * (protected streams, blueprint §2.4). Hono routes HEAD to these GET handlers.
 */
export function registerMediaRoutes(app: Hono<AppEnv>, container: AppContainer): void {
  const renditionsRefused = createRenditionCaps(container);

  app.get("/cdn/*", async (c) => {
    const key = blobKeyForCdnPath(c.req.path);
    if (!key) throw new AppError("not_found", { detail: "No such file" });
    return serveBlob(container, c, key, IMMUTABLE);
  });

  app.get("/media/*", async (c) => {
    const parsed = parseMediaPath(c.req.path);
    if (!parsed) throw new AppError("not_found", { detail: "No such file" });
    const access = await container.services.playback.authorizeMedia(
      parsed.token,
      parsed.assetId,
      parsed.key,
    );
    // The plan's cap covers every rendition, not only what the master playlist lists.
    if (access.maxVideoHeight !== null && parsed.key !== blobKeys.vodMaster(parsed.assetId)) {
      const refused = await renditionsRefused(parsed.assetId, access.maxVideoHeight);
      if (refused.some((prefix) => parsed.key.startsWith(prefix))) {
        throw new AppError("media_quality_restricted", {
          detail: `This plan streams up to ${access.maxVideoHeight}p`,
        });
      }
    }
    if (parsed.key.endsWith(".m3u8")) {
      if (access.maxVideoHeight !== null) {
        return servePlaylist(container, c, parsed.key, access.maxVideoHeight);
      }
      return serveBlob(container, c, parsed.key, "private, no-cache");
    }
    const remaining = Math.floor((access.expiresAt - container.clock.now()) / 1000);
    const maxAge = Math.max(0, Math.min(MEDIA_MAX_AGE_SEC, remaining));
    return serveBlob(container, c, parsed.key, `private, max-age=${maxAge}`);
  });
}
