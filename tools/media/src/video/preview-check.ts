/**
 * Checks on preview clips that need decoding: what their audio really is (so the manifest's
 * `hasAudio` comes from a measurement, never from whether a track exists), and that motion art
 * starts and ends exactly on the backdrop still the web shows before and after it plays.
 */
import { join } from "node:path";
import sharp from "sharp";
import { containerPath, ffmpeg, ffmpegReport, ffprobe } from "../docker.ts";
import { ensureDir } from "../util/fs.ts";

/** Audio peaking at or below this is not sound a member would turn on. */
export const SILENCE_PEAK_DBFS = -60;
/**
 * Motion art's first and last frames against the still, both reduced to `COMPARE_WIDTH` and
 * softened by `COMPARE_BLUR` (so grain and compression noise, which differ between the video
 * and the WebP still anyway, count for little, while a shift in framing or tone does not), in
 * levels (0-255): mean absolute error, mean signed shift in luma (BT.709 weights) and per
 * channel. Calibrated on every motion-art clip of both profiles against the master and the
 * published WebP: the grainiest backdrop at the bit-rate cap reaches 3.9 error and 2.2 luma
 * shift (2.3 and 1.8 of that even losslessly: resampling clips grain at black), and 4:2:0
 * chroma moves a saturated channel's mean by up to 4.5. A 2 % zoom gives 6-14 on any detailed
 * image, a vignette 5-20, a BT.601/709 slip a luma shift of 5-7 wherever it would be visible.
 */
export const COMPARE_WIDTH = 320;
export const COMPARE_BLUR = 1.5;
export const STILL_MAX_MAE = 4.5;
export const STILL_MAX_LUMA_SHIFT = 3;
export const STILL_MAX_CHANNEL_SHIFT = 6;

export interface AudioMeasurement {
  /** The file has an audio stream. */
  stream: boolean;
  /** Digital silence: no audio stream, or every sample zero. */
  silent: boolean;
  /** Sample peak and RMS level in dBFS; null when silent. (JSON-safe: no infinities.) */
  peakDb: number | null;
  rmsDb: number | null;
}

/** Overall `astats` value in dB; null for -inf (all samples zero) or when missing. */
function dbValue(log: string, label: string): number | null {
  // With measure_perchannel=none astats prints only the "Overall" block.
  const match = new RegExp(`${label} dB: (-?inf|-?[0-9.]+)`).exec(log);
  if (!match?.[1] || match[1].endsWith("inf")) return null;
  return Number(match[1]);
}

export async function measureAudio(path: string): Promise<AudioMeasurement> {
  const probe = await ffprobe(path);
  if (!probe.audio) return { stream: false, silent: true, peakDb: null, rmsDb: null };
  const log = await ffmpegReport([
    "-i",
    containerPath(path),
    "-map",
    "0:a:0",
    "-af",
    "astats=measure_perchannel=none",
    "-f",
    "null",
    "-",
  ]);
  if (!/Peak level dB:/.test(log)) throw new Error(`no astats report for ${path}`);
  const peakDb = dbValue(log, "Peak level");
  return { stream: true, silent: peakDb === null, peakDb, rmsDb: dbValue(log, "RMS level") };
}

/** Audible: a member turning the sound on would hear something. */
export function audible(audio: AudioMeasurement): boolean {
  return !audio.silent && audio.peakDb !== null && audio.peakDb > SILENCE_PEAK_DBFS;
}

/** Digitally silent: no audio stream, or every sample zero. */
export function digitallySilent(audio: AudioMeasurement): boolean {
  return audio.silent;
}

function describe(audio: AudioMeasurement): string {
  if (!audio.stream) return "no audio stream";
  if (audio.silent) return "all samples zero";
  return `peak ${audio.peakDb?.toFixed(1)} dBFS`;
}

/** The declared `hasAudio` (absent means true) against the measurement; null when they agree. */
export function audioDisagreement(
  declared: boolean | undefined,
  audio: AudioMeasurement,
): string | null {
  if (declared !== false && !audible(audio))
    return `declares sound (hasAudio ${declared === undefined ? "absent" : "true"}) but is silent (${describe(audio)})`;
  if (declared === false && !digitallySilent(audio))
    return `declares hasAudio: false but is not digitally silent (${describe(audio)})`;
  return null;
}

/** Decode a clip's first and last frames to PNG under `work`. */
export async function edgeFrames(path: string, work: string): Promise<[string, string]> {
  await ensureDir(work);
  const first = join(work, "first.png");
  const last = join(work, "last.png");
  const toRgb = "scale=flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24";
  await ffmpeg(["-i", containerPath(path), "-vf", toRgb, "-frames:v", "1", containerPath(first)]);
  await ffmpeg([
    "-sseof",
    "-0.5",
    "-i",
    containerPath(path),
    "-vf",
    toRgb,
    "-update",
    "1",
    containerPath(last),
  ]);
  return [first, last];
}

export interface StillDifference {
  mae: number;
  /** Mean signed difference per channel (frame minus still). */
  shift: [number, number, number];
  /** The same in luma (BT.709 weights). */
  lumaShift: number;
}

/** Compare a decoded frame with the still it should equal (both reduced to `width`). */
export async function stillDifference(
  frame: string,
  still: string,
  width = COMPARE_WIDTH,
  blur = COMPARE_BLUR,
): Promise<StillDifference> {
  const size = { width, height: Math.round((width * 9) / 16) };
  const reduce = (path: string) => {
    const image = sharp(path)
      .resize({ ...size, fit: "fill", kernel: "lanczos3" })
      .removeAlpha();
    return (blur > 0 ? image.blur(blur) : image).raw().toBuffer();
  };
  const a = { data: await reduce(frame) };
  const b = await reduce(still);
  let total = 0;
  const shift: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < a.data.length; i += 1) {
    const delta = (a.data[i] ?? 0) - (b[i] ?? 0);
    total += Math.abs(delta);
    shift[i % 3] = (shift[i % 3] ?? 0) + delta;
  }
  const pixels = a.data.length / 3;
  const [r, g, bl] = shift.map((value) => value / pixels) as [number, number, number];
  return {
    mae: total / a.data.length,
    shift: [r, g, bl],
    lumaShift: 0.2126 * r + 0.7152 * g + 0.0722 * bl,
  };
}

/** Null when the frame is the still (within tolerance), else what differs. */
export function stillMismatch(which: string, diff: StillDifference): string | null {
  const worst = Math.max(...diff.shift.map(Math.abs));
  if (
    diff.mae <= STILL_MAX_MAE &&
    Math.abs(diff.lumaShift) <= STILL_MAX_LUMA_SHIFT &&
    worst <= STILL_MAX_CHANNEL_SHIFT
  )
    return null;
  return `${which} frame differs from the backdrop still (mean error ${diff.mae.toFixed(2)}, luma shift ${diff.lumaShift.toFixed(2)}, colour shift ${diff.shift.map((v) => v.toFixed(2)).join("/")})`;
}

/** Motion art: first and last frames against the backdrop still. */
export async function checkMotionEdges(
  preview: string,
  still: string,
  work: string,
): Promise<{ first: StillDifference; last: StillDifference; problems: string[] }> {
  const [firstFrame, lastFrame] = await edgeFrames(preview, work);
  const first = await stillDifference(firstFrame, still);
  const last = await stillDifference(lastFrame, still);
  const problems = [stillMismatch("first", first), stillMismatch("last", last)].filter(
    (problem): problem is string => problem !== null,
  );
  return { first, last, problems };
}
