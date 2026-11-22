/**
 * Video stage: download and cache source films (once, shared by every profile), probe them,
 * fetch subtitles, then package every seed asset for a profile. Each asset is a cached step
 * keyed by its inputs, so a re-run with nothing changed does no ffmpeg work at all.
 */
import { basename, join } from "node:path";
import {
  blobKeys,
  type CatalogSeed,
  type MediaProfile,
  type PackagedVideoAsset,
  type PreviewKind,
} from "@webflix/contracts";
import { ensureImage, ffprobe, type ProbeResult } from "../docker.ts";
import { artMasterPath, DOWNLOADS_DIR, mediaCacheDir, TOOL_ROOT, workDir } from "../paths.ts";
import { PROFILES } from "../profiles.ts";
import { exists, readJson, writeJson } from "../util/fs.ts";
import { fingerprintFiles, hashJson, sha256, sha256File } from "../util/hash.ts";
import { formatDuration, log } from "../util/log.ts";
import { downloadFile } from "../util/net.ts";
import { mapPool } from "../util/pool.ts";
import { cachedStep, stampPath } from "../util/stamp.ts";
import { packageVideo, type SubtitleSource, type VideoJob, type VideoSource } from "./package.ts";
import { type FilmFacts, markersFor, planAssets, previewWindow, profileWindow } from "./plan.ts";
import { audible, digitallySilent, measureAudio } from "./preview-check.ts";

interface ResolvedSource {
  source: VideoSource;
  subtitles: SubtitleSource[];
}

function fileNameFor(url: string): string {
  const name = decodeURIComponent(basename(new URL(url).pathname)).replace(
    /[^A-Za-z0-9._-]+/g,
    "_",
  );
  return `${sha256(url).slice(0, 10)}-${name}`.slice(0, 120);
}

/** Download a source film and probe it; null when it cannot be fetched (caller falls back). */
export async function resolveFilm(
  url: string,
  sha: string | null,
): Promise<{ path: string; sha256: string; probe: ProbeResult } | null> {
  const path = join(DOWNLOADS_DIR, "films", fileNameFor(url));
  try {
    const record = await downloadFile(url, path, sha);
    const probePath = `${path}.probe.json`;
    const cached = await readJson<{ sha256: string; probe: ProbeResult }>(probePath);
    if (cached && cached.sha256 === record.sha256)
      return { path, sha256: record.sha256, probe: cached.probe };
    const probe = await ffprobe(path);
    await writeJson(probePath, { sha256: record.sha256, probe });
    return { path, sha256: record.sha256, probe };
  } catch (error) {
    log.warn(
      `source unavailable, using synthetic media instead: ${url} (${(error as Error).message})`,
    );
    return null;
  }
}

async function resolveSubtitles(
  filmKey: string,
  subtitles: FilmFacts["subtitles"],
): Promise<SubtitleSource[]> {
  const out: SubtitleSource[] = [];
  for (const [language, url] of subtitles) {
    const extension = /\.(srt|vtt)$/i.exec(new URL(url).pathname)?.[0]?.toLowerCase() ?? ".vtt";
    const path = join(DOWNLOADS_DIR, "subs", filmKey, `${language}${extension}`);
    try {
      await downloadFile(url, path, null, { parallel: false });
      out.push({ language, path });
    } catch (error) {
      log.warn(`subtitle ${language} for ${filmKey} unavailable: ${(error as Error).message}`);
    }
  }
  return out;
}

/**
 * What a preview declares (`kind`, `hasAudio`). Motion art is rendered without an audio track;
 * a footage clip's `hasAudio` is measured from its decoded audio (cached per preview file),
 * never inferred from the presence of a track. Metadata, so it sits outside the encode cache.
 */
async function previewFacts(
  job: VideoJob,
  out: string,
  work: string,
): Promise<{ kind: PreviewKind; hasAudio: boolean }> {
  if (job.source.kind === "artwork") return { kind: "motion", hasAudio: false };
  const path = join(out, blobKeys.preview(job.assetId));
  const sha = await sha256File(path);
  const { value } = await cachedStep(
    stampPath(work, "preview-audio", job.assetId),
    sha,
    async () => ({ value: await measureAudio(path), outputs: [] }),
  );
  if (!audible(value) && !digitallySilent(value)) {
    throw new Error(
      `${job.assetId}: preview audio is near-silent but not silent (peak ${value.peakDb} dBFS); strip the track or pick another excerpt`,
    );
  }
  return { kind: "footage", hasAudio: audible(value) };
}

export interface VideoStageOptions {
  /** Only package these asset ids (development). */
  only?: readonly string[];
}

export interface PreparedJob {
  seed: CatalogSeed["videoAssets"][number];
  job: VideoJob;
  /** The cache key for this job under the given code fingerprint. */
  keyFor: (code: string) => string;
  /** Which code fingerprint applies (motion art also depends on its recipe). */
  code: "footage" | "motion";
}

/** Code that shapes the packaged bytes, per kind of job. */
export async function codeFingerprints(): Promise<{ footage: string; motion: string }> {
  // plan.ts only decides windows, which are part of each job, and markers, which are metadata
  // applied after the cache. Footage does not depend on the motion-art recipe, so a new recipe
  // re-renders only the motion-art clips.
  const footageFiles = ["package.ts", "hls.ts", "subtitles.ts"];
  const codeFor = (files: string[]) =>
    fingerprintFiles(files.map((file) => join(TOOL_ROOT, "src", "video", file)));
  return {
    footage: await codeFor(footageFiles),
    // (preview-check.ts only checks the result; validate-manifest checks every clip again.)
    motion: await codeFor([...footageFiles, "motion.ts"]),
  };
}

/** Resolve sources and build every packaging job of a profile, with its cache key. */
export async function prepareVideoJobs(
  catalog: CatalogSeed,
  films: ReadonlyMap<string, FilmFacts & { key: string }>,
  profile: MediaProfile,
  options: VideoStageOptions = {},
): Promise<PreparedJob[]> {
  const config = PROFILES[profile];
  const image = await ensureImage();
  const planned = planAssets(catalog).filter(
    (asset) => !options.only || options.only.includes(asset.seed.id),
  );

  // Fetch each distinct source once (sequentially: be gentle with the hosts).
  const sources = new Map<string, ResolvedSource | null>();
  for (const asset of planned) {
    const source = asset.seed.source;
    if (source.kind !== "download" || sources.has(source.url)) continue;
    const film = films.get(source.url) ?? null;
    const file = await resolveFilm(source.url, source.sha256);
    if (!file) {
      sources.set(source.url, null);
      continue;
    }
    const subtitles = film ? await resolveSubtitles(film.key, film.subtitles) : [];
    sources.set(source.url, { source: { kind: "file", ...file }, subtitles });
  }

  return mapPool(planned, 8, async (asset) => {
    const seed = asset.seed;
    const download = seed.source.kind === "download" ? seed.source : null;
    const resolved = download ? sources.get(download.url) : null;
    const film = download ? (films.get(download.url) ?? null) : null;
    const sourceDuration =
      resolved?.source.kind === "file"
        ? resolved.source.probe.durationSec
        : (film?.durationSec ?? (seed.source.kind === "synthetic" ? seed.source.durationSec : 600));
    const window = profileWindow(asset, sourceDuration, config);
    let source: VideoSource = resolved?.source ?? {
      kind: "synthetic",
      label: seed.label,
      hue: Number.parseInt(sha256(seed.id).slice(0, 4), 16) % 360,
    };
    if (asset.artTitleId) {
      const master = artMasterPath(asset.artTitleId);
      if (await exists(master)) {
        source = {
          kind: "artwork",
          path: master,
          sha256: await sha256File(master),
          seed: Number.parseInt(sha256(asset.artTitleId).slice(0, 8), 16),
        };
      }
    }
    const ladder =
      asset.role === "preview"
        ? []
        : asset.feature
          ? (config.featureLadder ?? config.ladder)
          : config.ladder;
    const job: VideoJob = {
      assetId: seed.id,
      label: seed.label,
      role: asset.role === "preview" ? "preview-only" : "main",
      ladder,
      source,
      window,
      preview: previewWindow(asset, window, config),
      subtitles: asset.role === "preview" ? [] : (resolved?.subtitles ?? []),
      markers: markersFor(asset, window, film),
    };
    // Keyed by what shapes the bytes only: markers and labels are metadata, applied after.
    const keyFor = (code: string) =>
      hashJson({
        job: {
          assetId: job.assetId,
          role: job.role,
          ladder: job.ladder,
          source:
            source.kind === "file"
              ? { sha256: source.sha256 }
              : source.kind === "artwork"
                ? { kind: "artwork", sha256: source.sha256, seed: source.seed }
                : source,
          window: job.window,
          preview: job.preview,
          subtitles: job.subtitles.map((subtitle) => subtitle.language),
        },
        encode: {
          preset: config.preset,
          segmentSec: config.segmentSec,
          audioKbps: config.audioKbps,
          preview: config.preview,
          trickPlay: config.trickPlay,
        },
        image,
        code,
      });
    return { seed, job, keyFor, code: source.kind === "artwork" ? "motion" : "footage" };
  });
}

export async function runVideoStage(
  catalog: CatalogSeed,
  films: ReadonlyMap<string, FilmFacts & { key: string }>,
  profile: MediaProfile,
  options: VideoStageOptions = {},
): Promise<PackagedVideoAsset[]> {
  const config = PROFILES[profile];
  const codes = await codeFingerprints();
  const prepared = await prepareVideoJobs(catalog, films, profile, options);
  const out = mediaCacheDir(profile);
  const work = workDir(profile);
  let packaged = 0;
  const started = Date.now();
  const results = await mapPool(prepared, config.jobs, async ({ seed, job, keyFor, code }) => {
    const key = keyFor(codes[code]);
    const step = await cachedStep(stampPath(work, "video", seed.id), key, async () => {
      const result = await packageVideo(job, config, { out, work: join(work, "video", seed.id) });
      // A synthetic stand-in (failed download, or art not rendered yet) is not cached: the
      // next run retries.
      const provisional = job.source.kind === "synthetic";
      return { value: result.asset, outputs: result.outputs, provisional };
    });
    const { cached } = step;
    const value: PackagedVideoAsset = {
      ...step.value,
      markers: job.markers,
      preview: step.value.preview
        ? { ...step.value.preview, ...(await previewFacts(job, out, work)) }
        : null,
    };
    if (!cached) {
      packaged += 1;
      log.info(
        `packaged ${seed.id} (${job.role}, ${job.window.durationSec.toFixed(0)} s${job.source.kind === "synthetic" ? ", synthetic" : ""})`,
      );
    }
    return value;
  });
  log.info(
    `video: ${results.length} assets (${packaged} packaged, ${results.length - packaged} cached) in ${formatDuration(Date.now() - started)}`,
  );
  return results;
}
