import { join, resolve } from "node:path";
import type { MediaProfile } from "@webflix/contracts";

/** Repository root (tools/media/src → ../../..). */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** `tools/media`. */
export const TOOL_ROOT = resolve(import.meta.dirname, "..");

/** Self-hosted, openly licensed display fonts used for title treatments (committed). */
export const FONTS_DIR = join(TOOL_ROOT, "fonts");

/** Everything the pipeline writes lives under here (git-ignored). */
export const MEDIA_ROOT = join(REPO_ROOT, ".cache", "media");

/**
 * Cache layout (see tools/media/README.md):
 *
 *   .cache/media/downloads/   source films, subtitles, photos (shared by every profile)
 *   .cache/media/art/         rendered artwork in blob layout (profile-independent)
 *   .cache/media/work/<p>/    intermediates and step stamps for one profile
 *   .cache/media/<p>/         the publishable tree: public/…, vod/…, manifest.json
 */
export const DOWNLOADS_DIR = join(MEDIA_ROOT, "downloads");
export const ART_DIR = join(MEDIA_ROOT, "art");

/**
 * A title's textless backdrop master (1920×1080 PNG), written by the art stage and read by the
 * video stage to render its motion-art preview.
 */
export function artMasterPath(titleId: string): string {
  return join(MEDIA_ROOT, "work", "art", "masters", titleId, "backdrop.png");
}

export function workDir(profile: MediaProfile, root = REPO_ROOT): string {
  return join(root, ".cache", "media", "work", profile);
}

/**
 * Where packaged output for a profile lives (git-ignored). The directory mirrors the blob
 * layout (`public/...`, `vod/...`) plus `manifest.json`, ready to upload to any BlobStore.
 */
export function mediaCacheDir(profile: MediaProfile, root = REPO_ROOT): string {
  return join(root, ".cache", "media", profile);
}

export function manifestPath(profile: MediaProfile, root = REPO_ROOT): string {
  return join(mediaCacheDir(profile, root), "manifest.json");
}

/** Default dev-mode blob store root (`apps/api` reads the same `WEBFLIX_BLOB_DIR`). */
export function defaultBlobDir(): string {
  return process.env.WEBFLIX_BLOB_DIR ?? join(REPO_ROOT, ".data", "blobs");
}
