/**
 * Packages one video asset: H.264 ABR ladder + demuxed AAC audio as fMP4/CMAF HLS, side-car
 * WebVTT subtitles, trick-play sprite sheets, and a short muted-autoplay preview MP4.
 *
 *   vod/{assetId}/master.m3u8
 *   vod/{assetId}/{rung}/index.m3u8, init.mp4, seg_00000.m4s …
 *   vod/{assetId}/audio/index.m3u8, init.mp4, seg_…
 *   vod/{assetId}/subs/{lang}.vtt
 *   vod/{assetId}/trickplay/sheet-000.jpg …
 *   public/previews/{assetId}/preview.mp4
 *
 * Motion-art previews (`artwork` sources) are rendered from a title's own textless backdrop:
 * a slow eased push and drift, a soft light passing across, film grain and a vignette, faded
 * in and out of black so the clip loops cleanly.
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  blobKeys,
  type PackagedVideoAsset,
  type TextTrackFile,
  type TrickPlayFiles,
} from "@webflix/contracts";
import sharp from "sharp";
import { containerPath, ffmpeg, type ProbeResult } from "../docker.ts";
import { AAC_LC, avcCodecString, type ProfileConfig, type Rung } from "../profiles.ts";
import { ensureDir, listFiles, writeFileAtomic } from "../util/fs.ts";
import { buildMasterPlaylist, type MasterVariant, measurePlaylist } from "./hls.ts";
import { clipCues, decodeSubtitleBytes, languageLabel, parseCues, toWebVtt } from "./subtitles.ts";
import { checkTiming } from "./validate.ts";

export interface TimeWindow {
  startSec: number;
  durationSec: number;
}

export type VideoSource =
  | { kind: "file"; path: string; sha256: string; probe: ProbeResult }
  | { kind: "synthetic"; label: string; hue: number }
  /** A title's textless backdrop master (1920×1080 PNG); `seed` varies the camera move. */
  | { kind: "artwork"; path: string; sha256: string; seed: number };

export interface SubtitleSource {
  language: string;
  /** Raw SRT/VTT for the whole source film (decoded and clipped here). */
  path: string;
}

export interface Markers {
  intro: { startSec: number; endSec: number } | null;
  recap: { startSec: number; endSec: number } | null;
  creditsStartSec: number | null;
}

export interface VideoJob {
  assetId: string;
  label: string;
  /** `main`: played by a title or episode (full ladder). `preview-only`: just a preview clip. */
  role: "main" | "preview-only";
  /** The ABR ladder for `main` jobs (movies may carry an extra top rung). */
  ladder: readonly Rung[];
  source: VideoSource;
  /** What gets packaged, in source time. */
  window: TimeWindow;
  /** The preview excerpt, in source time; null when no title previews this asset. */
  preview: TimeWindow | null;
  subtitles: readonly SubtitleSource[];
  /** In the packaged asset's own timeline (0 = window start). */
  markers: Markers;
}

export interface PackageDirs {
  /** `.cache/media/<profile>`: receives `vod/…` and `public/previews/…`. */
  out: string;
  /** Scratch space for this asset (trick-play frames). */
  work: string;
}

const SYNTHETIC_SIZE = { width: 1920, height: 1080, frameRate: 24 };
const ARTWORK_SIZE = { width: 1920, height: 1080, frameRate: 24 };

function previewFrameRate(source: VideoSource): number {
  const rate = sourceGeometry(source).frameRate;
  return rate > 31 ? rate / 2 : rate;
}

function sourceGeometry(source: VideoSource) {
  if (source.kind === "synthetic") return SYNTHETIC_SIZE;
  if (source.kind === "artwork") return ARTWORK_SIZE;
  const video = source.probe.video;
  if (!video) throw new Error(`source has no video stream: ${source.path}`);
  return { width: video.width, height: video.height, frameRate: video.frameRate || 24 };
}

/** ffmpeg input arguments for the window of a source (synthetic sources are generated). */
function inputArgs(source: VideoSource, window: TimeWindow): string[] {
  if (source.kind === "file") {
    return [
      "-ss",
      window.startSec.toFixed(3),
      "-t",
      window.durationSec.toFixed(3),
      "-i",
      containerPath(source.path),
    ];
  }
  if (source.kind === "artwork") {
    // One still frame (zoompan turns it into the clip) and a silent stereo track, so the
    // preview's HLS rendition really has the AAC audio its CODECS attribute declares.
    return [
      "-i",
      containerPath(source.path),
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=48000:cl=stereo:d=${window.durationSec}`,
    ];
  }
  // Offline fallback: a slow colour drift with the asset label and a running timecode, plus
  // quiet pink noise, so players, ladders and previews all behave like the real thing.
  const { width, height, frameRate } = SYNTHETIC_SIZE;
  const hueA = source.hue % 360;
  const hueB = (source.hue + 140) % 360;
  const color = (hue: number, light: number) => {
    const c = (1 - Math.abs(2 * light - 1)) * 0.55;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = light - c / 2;
    const [r, g, b] =
      hue < 60
        ? [c, x, 0]
        : hue < 120
          ? [x, c, 0]
          : hue < 180
            ? [0, c, x]
            : hue < 240
              ? [0, x, c]
              : hue < 300
                ? [x, 0, c]
                : [c, 0, x];
    const hex = (v: number) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, "0");
    return `0x${hex(r)}${hex(g)}${hex(b)}`;
  };
  const label = source.label.replace(/[':\\%]/g, " ");
  const font = "/usr/share/fonts/dejavu/DejaVuSans.ttf";
  const video = [
    `gradients=s=${width}x${height}:r=${frameRate}:d=${window.durationSec}:speed=0.008:c0=${color(hueA, 0.18)}:c1=${color(hueB, 0.32)}:x0=0:y0=0:x1=${width}:y1=${height}`,
    `drawtext=fontfile=${font}:text='${label}':fontcolor=white@0.92:fontsize=64:x=(w-tw)/2:y=h*0.42`,
    `drawtext=fontfile=${font}:text='Sample stream · %{pts\\:hms}':fontcolor=white@0.6:fontsize=34:x=(w-tw)/2:y=h*0.42+96`,
  ].join(",");
  return [
    "-f",
    "lavfi",
    "-i",
    video,
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=color=pink:amplitude=0.02:sample_rate=48000:d=${window.durationSec}`,
  ];
}

function audioInput(source: VideoSource): string | null {
  if (source.kind === "synthetic" || source.kind === "artwork") return "1:a:0";
  return source.probe.audio ? "0:a:0" : null;
}

/** Rungs no wider than the source (never upscale), always at least the smallest. */
export function ladderFor(ladder: readonly Rung[], sourceWidth: number): Rung[] {
  const fitting = ladder.filter((rung) => rung.width <= sourceWidth);
  const smallest = ladder[ladder.length - 1];
  return fitting.length > 0 ? fitting : smallest ? [smallest] : [];
}

function evenHeight(width: number, sourceWidth: number, sourceHeight: number): number {
  return Math.max(2, Math.round((width * sourceHeight) / sourceWidth / 2) * 2);
}

/** Trick-play interval: about a hundred thumbnails per asset, between 2 and 10 seconds apart. */
export function trickPlayInterval(durationSec: number): number {
  return Math.min(10, Math.max(2, Math.round(durationSec / 100)));
}

/**
 * HLS fMP4 output that starts presenting at 0: timestamps are passed through untouched (no
 * shifting DTS to non-negative, which delays every B-frame stream by its reorder depth and
 * forces an empty edit) and B-frames use negative composition offsets (trun v1, CMAF style),
 * so each fragment's first presented frame is its `tfdt`. GOPs are identical across rungs, so
 * segments stay aligned and independent.
 */
function hlsOutput(dir: string, segmentSec: number): string[] {
  return [
    "-avoid_negative_ts",
    "disabled",
    "-f",
    "hls",
    "-hls_segment_options",
    "movflags=+cmaf+negative_cts_offsets",
    "-hls_time",
    String(segmentSec),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_filename",
    `${containerPath(dir)}/seg_%05d.m4s`,
    "-hls_flags",
    "independent_segments",
    `${containerPath(dir)}/index.m3u8`,
  ];
}

async function encodeLadder(
  job: VideoJob,
  config: ProfileConfig,
  vodDir: string,
  framesDir: string,
): Promise<{
  rungs: (Rung & { height: number })[];
  frameRate: number;
  interval: number;
  hasAudio: boolean;
}> {
  const geometry = sourceGeometry(job.source);
  const rungs = ladderFor(job.ladder, geometry.width).map((rung) => ({
    ...rung,
    height: evenHeight(rung.width, geometry.width, geometry.height),
  }));
  // High-frame-rate sources (the 60 fps Big Buck Bunny re-render) are halved: streaming
  // them at 60 fps would double every rung's bitrate for little visible gain.
  const halve = geometry.frameRate > 31;
  const frameRate = halve ? geometry.frameRate / 2 : geometry.frameRate;
  const gop = Math.max(1, Math.round(frameRate * 2));
  const interval = trickPlayInterval(job.window.durationSec);
  const tileHeight = evenHeight(config.trickPlay.tileWidth, geometry.width, geometry.height);

  const splits = rungs.map((_, index) => `[s${index}]`).join("");
  const filters = [
    // Constant frame rate, exactly the window long: some masters hold single frames for up to
    // a second (the Elephants Dream .mov) or end their picture a little before their sound
    // (Caminandes 2); the last frame is held to the window's end, and anything past it is cut,
    // so video and audio renditions end together.
    `[0:v]setsar=1,fps=${frameRate},tpad=stop_mode=clone:stop_duration=${job.window.durationSec.toFixed(3)},trim=end=${job.window.durationSec.toFixed(3)},split=${rungs.length + 1}${splits}[st]`,
    ...rungs.map(
      (rung, index) =>
        `[s${index}]scale=${rung.width}:${rung.height}:flags=lanczos,format=yuv420p[v${index}]`,
    ),
    // Thumbnail i covers [i*interval, (i+1)*interval): take the frame in the middle of that
    // window, chosen by frame index (exact for constant-rate sources, unlike the fps filter,
    // which can land a frame interval early or late).
    `[st]select='gte(n,${Math.round((interval / 2) * frameRate)})*not(mod(n-${Math.round((interval / 2) * frameRate)},${Math.round(interval * frameRate)}))',scale=${config.trickPlay.tileWidth}:${tileHeight}:flags=lanczos[tp]`,
  ];

  const args = [...inputArgs(job.source, job.window), "-filter_complex", filters.join(";")];
  rungs.forEach((rung, index) => {
    const dir = join(vodDir, rung.id);
    args.push(
      "-map",
      `[v${index}]`,
      "-c:v",
      "libx264",
      "-preset",
      config.preset,
      "-profile:v",
      "high",
      "-level:v",
      rung.level,
      "-crf",
      String(rung.crf),
      "-maxrate",
      `${rung.maxrateKbps}k`,
      "-bufsize",
      `${rung.maxrateKbps * 2}k`,
      "-g",
      String(gop),
      "-keyint_min",
      String(gop),
      "-sc_threshold",
      "0",
      "-force_key_frames",
      "expr:gte(t,n_forced*2)",
      "-an",
      "-sn",
      "-dn",
      ...hlsOutput(dir, config.segmentSec),
    );
  });
  const audio = audioInput(job.source);
  if (audio) {
    const end = job.window.durationSec.toFixed(3);
    args.push(
      "-map",
      audio,
      "-vn",
      "-sn",
      "-dn",
      // Exactly the window long, like the video: some masters' sound stops before the picture
      // (Wing It!'s credits), which would leave the audio rendition seconds short.
      "-af",
      `apad=whole_dur=${end},atrim=end=${end}`,
      "-c:a",
      "aac",
      "-b:a",
      `${config.audioKbps}k`,
      "-ac",
      "2",
      "-ar",
      "48000",
      ...hlsOutput(join(vodDir, "audio"), config.segmentSec),
    );
  }
  args.push(
    "-map",
    "[tp]",
    "-fps_mode",
    "passthrough",
    "-c:v",
    "mjpeg",
    "-q:v",
    "3",
    "-f",
    "image2",
    `${containerPath(framesDir)}/%05d.jpg`,
  );

  for (const rung of rungs) await ensureDir(join(vodDir, rung.id));
  if (audio) await ensureDir(join(vodDir, "audio"));
  await ensureDir(framesDir);
  await ffmpeg(args);
  return { rungs, frameRate, interval, hasAudio: audio !== null };
}

/** Pack extracted thumbnails into full-size sprite sheets (row-major, black padding). */
async function buildTrickPlay(
  framesDir: string,
  vodDir: string,
  assetId: string,
  interval: number,
  config: ProfileConfig,
): Promise<TrickPlayFiles | null> {
  const frames = (await readdir(framesDir)).filter((name) => name.endsWith(".jpg")).sort();
  if (frames.length === 0) return null;
  const first = await sharp(join(framesDir, frames[0] as string)).metadata();
  const tileWidth = first.width ?? config.trickPlay.tileWidth;
  const tileHeight = first.height ?? Math.round((tileWidth * 9) / 16);
  const { columns, rows } = config.trickPlay;
  const perSheet = columns * rows;
  const sheets: string[] = [];
  const dir = await ensureDir(join(vodDir, "trickplay"));
  for (let offset = 0; offset < frames.length; offset += perSheet) {
    const chunk = frames.slice(offset, offset + perSheet);
    const index = sheets.length;
    const name = `sheet-${String(index).padStart(3, "0")}.jpg`;
    await sharp({
      create: {
        width: tileWidth * columns,
        height: tileHeight * rows,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite(
        chunk.map((frame, cell) => ({
          input: join(framesDir, frame),
          left: (cell % columns) * tileWidth,
          top: Math.floor(cell / columns) * tileHeight,
        })),
      )
      .jpeg({ quality: 72, mozjpeg: true })
      .toFile(join(dir, name));
    sheets.push(`${blobKeys.vodPrefix(assetId)}trickplay/${name}`);
  }
  return {
    intervalSec: interval,
    tileWidth,
    tileHeight,
    columns,
    rows,
    count: frames.length,
    sheets,
  };
}

/** Deterministic pseudo-random values in [0, 1) from a seed. */
function seeded(seed: number, count: number): number[] {
  const out: number[] = [];
  let state = seed >>> 0 || 1;
  for (let i = 0; i < count; i += 1) {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    out.push(state / 2 ** 32);
  }
  return out;
}

/**
 * Motion art from a still: an eased push (in or out) with a slow drift, a soft warm light
 * that passes across the frame, a breathing exposure, grain and a vignette, faded in and out
 * of black. The still is upscaled 2x first so the zoom moves in sub-pixel steps.
 * Inputs: 0 = still, 1 = silent audio, 2 = light sprite (looped).
 */
export function motionArtFilter(
  seed: number,
  durationSec: number,
  width: number,
  height: number,
): string {
  const [direction = 0, ax = 0, ay = 0, bx = 0, by = 0, light = 0] = seeded(seed, 6);
  const frames = Math.round(durationSec * 24);
  const pushIn = direction < 0.65;
  const [z0, z1] = pushIn ? [1.0, 1.1] : [1.1, 1.0];
  // Drift between two points near the middle of the frame.
  const fx = 0.35 + ax * 0.3;
  const fy = 0.35 + ay * 0.3;
  const tx = 0.45 + bx * 0.3;
  const ty = 0.4 + by * 0.2;
  const ease = `(0.5-0.5*cos(PI*on/${frames - 1}))`;
  const fixed = (value: number) => value.toFixed(4);
  // The light sprite is as wide as the frame; it crosses from one side to the other.
  const leftToRight = light < 0.5;
  const x0 = leftToRight ? -width : width;
  const x1 = leftToRight ? width : -width;
  const lightY = Math.round(-height * (0.45 - light * 0.3));
  const fadeOut = Math.max(0, durationSec - 1).toFixed(2);
  return [
    `[0:v]scale=3840:2160:flags=lanczos,zoompan=z='${z0}+${fixed(z1 - z0)}*${ease}':x='(iw-iw/zoom)*(${fixed(fx)}+${fixed(tx - fx)}*${ease})':y='(ih-ih/zoom)*(${fixed(fy)}+${fixed(ty - fy)}*${ease})':d=${frames}:s=${width}x${height}:fps=24,format=rgba[base]`,
    "[2:v]format=rgba[light]",
    `[base][light]overlay=x='${x0}+(${x1 - x0})*t/${durationSec}':y=${lightY}:shortest=1:eval=frame,eq=brightness='0.015*sin(2*PI*t/${durationSec})':eval=frame,vignette=angle=PI/6,format=yuv420p,noise=c0s=6:c0f=t+u,setsar=1,fade=t=in:st=0:d=0.8,fade=t=out:st=${fadeOut}:d=1[v]`,
  ].join(";");
}

/** A soft warm light sprite (transparent edges) the size of the preview frame. */
async function lightSprite(target: string, width: number, height: number): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height * 2}"><defs><radialGradient id="l" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff3df" stop-opacity="0.26"/><stop offset="0.45" stop-color="#ffe9c8" stop-opacity="0.11"/><stop offset="1" stop-color="#ffe9c8" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#l)"/></svg>`;
  await ensureDir(join(target, ".."));
  await sharp(Buffer.from(svg)).png().toFile(target);
}

async function encodeMotionArt(
  job: VideoJob,
  window: TimeWindow,
  config: ProfileConfig,
  target: string,
  work: string,
): Promise<void> {
  if (job.source.kind !== "artwork") throw new Error(`${job.assetId} is not motion art`);
  const { width, height, maxrateKbps, crf, audioKbps } = config.preview;
  const light = join(work, "light.png");
  await lightSprite(light, width, height);
  await ensureDir(join(target, ".."));
  await ffmpeg([
    ...inputArgs(job.source, window),
    "-loop",
    "1",
    "-framerate",
    "24",
    "-i",
    containerPath(light),
    "-filter_complex",
    motionArtFilter(job.source.seed, window.durationSec, width, height),
    "-map",
    "[v]",
    "-map",
    "1:a:0",
    "-t",
    window.durationSec.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    config.preset,
    "-profile:v",
    "high",
    "-level:v",
    "3.1",
    "-crf",
    String(crf),
    "-maxrate",
    `${maxrateKbps}k`,
    "-bufsize",
    `${maxrateKbps * 2}k`,
    "-force_key_frames",
    "expr:gte(t,n_forced*2)",
    "-c:a",
    "aac",
    "-b:a",
    `${audioKbps}k`,
    "-ac",
    "2",
    "-ar",
    "48000",
    "-avoid_negative_ts",
    "disabled",
    "-movflags",
    "+faststart+negative_cts_offsets",
    containerPath(target),
  ]);
}

async function encodePreview(
  job: VideoJob,
  window: TimeWindow,
  config: ProfileConfig,
  target: string,
): Promise<void> {
  const { width, height, maxrateKbps, crf, audioKbps } = config.preview;
  const fadeOut = Math.max(0, window.durationSec - 0.8);
  const video = [
    // Centre-crop to 16:9 so previews fill cards and the billboard edge to edge.
    "crop=w='min(iw,ih*16/9)':h='min(ih,iw*9/16)'",
    `fps=${previewFrameRate(job.source)}`,
    `tpad=stop_mode=clone:stop_duration=${window.durationSec.toFixed(3)}`,
    `trim=end=${window.durationSec.toFixed(3)}`,
    `scale=${width}:${height}:flags=lanczos`,
    "setsar=1",
    "fade=t=in:st=0:d=0.5",
    `fade=t=out:st=${fadeOut.toFixed(2)}:d=0.8`,
    "format=yuv420p",
  ].join(",");
  const audio = audioInput(job.source);
  await ensureDir(join(target, ".."));
  await ffmpeg([
    ...inputArgs(job.source, window),
    "-map",
    "0:v:0",
    ...(audio ? ["-map", audio] : []),
    "-vf",
    video,
    "-c:v",
    "libx264",
    "-preset",
    config.preset,
    "-profile:v",
    "high",
    "-level:v",
    "3.1",
    "-crf",
    String(crf),
    "-maxrate",
    `${maxrateKbps}k`,
    "-bufsize",
    `${maxrateKbps * 2}k`,
    "-force_key_frames",
    "expr:gte(t,n_forced*2)",
    ...(audio
      ? [
          "-af",
          `apad=whole_dur=${window.durationSec.toFixed(3)},atrim=end=${window.durationSec.toFixed(3)},afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOut.toFixed(2)}:d=0.8`,
          "-c:a",
          "aac",
          "-b:a",
          `${audioKbps}k`,
          "-ac",
          "2",
          "-ar",
          "48000",
        ]
      : ["-an"]),
    "-avoid_negative_ts",
    "disabled",
    "-movflags",
    "+faststart+negative_cts_offsets",
    containerPath(target),
  ]);
}

/** Preview-only assets still need a playable master: remux the preview into fMP4 HLS. */
async function remuxPreviewToHls(
  previewPath: string,
  vodDir: string,
  segmentSec: number,
): Promise<void> {
  const dir = await ensureDir(join(vodDir, "main"));
  await ffmpeg([
    "-i",
    containerPath(previewPath),
    "-map",
    "0",
    "-c",
    "copy",
    ...hlsOutput(dir, segmentSec),
  ]);
}

async function writeSubtitles(job: VideoJob, vodDir: string): Promise<TextTrackFile[]> {
  const tracks: TextTrackFile[] = [];
  if (job.subtitles.length === 0) return tracks;
  const dir = await ensureDir(join(vodDir, "subs"));
  for (const subtitle of job.subtitles) {
    const text = decodeSubtitleBytes(await readFile(subtitle.path), subtitle.language);
    const cues = clipCues(parseCues(text), job.window.startSec, job.window.durationSec);
    if (cues.length === 0) continue;
    await writeFileAtomic(join(dir, `${subtitle.language}.vtt`), toWebVtt(cues));
    tracks.push({
      id: `sub-${subtitle.language}`,
      language: subtitle.language,
      label: languageLabel(subtitle.language),
      kind: "subtitles",
      default: false,
      forced: false,
      key: `${blobKeys.vodPrefix(job.assetId)}subs/${subtitle.language}.vtt`,
    });
  }
  return tracks;
}

async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const file of await listFiles(dir)) {
    const { size } = await import("node:fs/promises").then((fs) => fs.stat(join(dir, file)));
    total += size;
  }
  return total;
}

/** Package one asset from scratch (the caller handles caching). */
export async function packageVideo(
  job: VideoJob,
  config: ProfileConfig,
  dirs: PackageDirs,
): Promise<{ asset: PackagedVideoAsset; outputs: string[] }> {
  const vodDir = join(dirs.out, "vod", job.assetId);
  const previewKey = blobKeys.preview(job.assetId);
  const previewPath = join(dirs.out, previewKey);
  await rm(vodDir, { recursive: true, force: true });
  await rm(dirs.work, { recursive: true, force: true });
  await rm(previewPath, { force: true });
  await ensureDir(vodDir);

  if (job.preview) {
    if (job.source.kind === "artwork") {
      await encodeMotionArt(job, job.preview, config, previewPath, dirs.work);
    } else {
      await encodePreview(job, job.preview, config, previewPath);
    }
  }

  let variants: MasterVariant[];
  let audio: Parameters<typeof buildMasterPlaylist>[1] = null;
  let trickPlay: TrickPlayFiles | null = null;
  let renditions: PackagedVideoAsset["renditions"];
  let audioRenditions: PackagedVideoAsset["audio"] = [];
  const muxedAudio = job.role === "preview-only";

  if (job.role === "main") {
    const framesDir = join(dirs.work, "frames");
    const encoded = await encodeLadder(job, config, vodDir, framesDir);
    variants = [];
    renditions = [];
    for (const rung of encoded.rungs) {
      const stats = await measurePlaylist(join(vodDir, rung.id, "index.m3u8"));
      const codec = avcCodecString(rung.level);
      variants.push({
        uri: `${rung.id}/index.m3u8`,
        width: rung.width,
        height: rung.height,
        frameRate: encoded.frameRate,
        videoCodec: codec,
        stats,
      });
    }
    if (encoded.hasAudio) {
      const stats = await measurePlaylist(join(vodDir, "audio", "index.m3u8"));
      audio = {
        uri: "audio/index.m3u8",
        language: "en",
        name: "Original",
        codec: AAC_LC,
        channels: 2,
        stats,
      };
      audioRenditions = [
        {
          id: "audio-original",
          language: "en",
          label: "Original",
          codecs: AAC_LC,
          channels: 2,
          default: true,
          playlist: `${blobKeys.vodPrefix(job.assetId)}audio/index.m3u8`,
        },
      ];
    }
    renditions = variants.map((variant) => ({
      id: variant.uri.split("/")[0] ?? variant.uri,
      width: variant.width,
      height: variant.height,
      bandwidth: variant.stats.peakBps + (audio?.stats.peakBps ?? 0),
      codecs: [variant.videoCodec, audio?.codec].filter(Boolean).join(","),
      frameRate: variant.frameRate,
      playlist: `${blobKeys.vodPrefix(job.assetId)}${variant.uri}`,
    }));
    trickPlay = await buildTrickPlay(framesDir, vodDir, job.assetId, encoded.interval, config);
  } else {
    if (!job.preview) throw new Error(`preview-only asset ${job.assetId} has no preview window`);
    await remuxPreviewToHls(previewPath, vodDir, config.segmentSec);
    const stats = await measurePlaylist(join(vodDir, "main", "index.m3u8"));
    const codec = avcCodecString("3.1");
    variants = [
      {
        uri: "main/index.m3u8",
        width: config.preview.width,
        height: config.preview.height,
        frameRate: previewFrameRate(job.source),
        videoCodec: codec,
        stats,
      },
    ];
    renditions = [
      {
        id: "main",
        width: config.preview.width,
        height: config.preview.height,
        bandwidth: stats.peakBps,
        codecs: `${codec},${AAC_LC}`,
        frameRate: previewFrameRate(job.source),
        playlist: `${blobKeys.vodPrefix(job.assetId)}main/index.m3u8`,
      },
    ];
  }

  await writeFileAtomic(
    join(vodDir, "master.m3u8"),
    buildMasterPlaylist(variants, audio, muxedAudio ? AAC_LC : null),
  );
  const textTracks = await writeSubtitles(job, vodDir);
  const durationSec = variants[0]?.stats.durationSec ?? job.window.durationSec;
  const previewBytes = job.preview
    ? (await import("node:fs/promises").then((fs) => fs.stat(previewPath))).size
    : 0;
  const asset: PackagedVideoAsset = {
    assetId: job.assetId,
    // Motion art is intended content, not a stand-in for footage that failed to download.
    synthetic: job.source.kind === "synthetic",
    durationSec: Math.round(durationSec * 1000) / 1000,
    master: blobKeys.vodMaster(job.assetId),
    renditions,
    audio: audioRenditions,
    textTracks,
    trickPlay,
    preview: job.preview
      ? {
          key: previewKey,
          durationSec: job.preview.durationSec,
          width: config.preview.width,
          height: config.preview.height,
        }
      : null,
    markers: job.markers,
    bytes: (await treeBytes(vodDir)) + previewBytes,
  };
  await rm(dirs.work, { recursive: true, force: true });
  // Fail the asset rather than ship media that does not start at 0 (hls.js start gaps, stalls).
  const timing = await checkTiming(dirs.out, asset);
  if (timing.problems.length > 0) {
    throw new Error(`packaged timing is wrong:\n  ${timing.problems.join("\n  ")}`);
  }
  return { asset, outputs: [join(vodDir, "master.m3u8"), ...(job.preview ? [previewPath] : [])] };
}
