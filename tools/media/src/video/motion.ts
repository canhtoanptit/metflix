/**
 * Motion art: a preview clip rendered from a title's own textless backdrop, for titles with no
 * footage of their own. The web plays it over the backdrop still on the billboard and the
 * detail hero, so the clip has to start and end exactly on that still:
 *
 *   - frame 0 and the last frame are the backdrop itself (zoom 1, no fade, grade, grain or
 *     vignette; BT.709 conversion and tagging, so the colours do not shift when it starts);
 *   - in between, a push towards a drifting point that peaks at `zoom` (1.20-1.25, about a
 *   fifth of the frame: readable at billboard size) half-way through and eases back, so the
 *     clip also loops seamlessly;
 *   - a soft warm light crosses the frame, entering and leaving off-screen;
 *   - no audio track at all (the manifest declares `kind: "motion"`, `hasAudio: false`).
 */
import { join } from "node:path";
import sharp from "sharp";
import { containerPath, ffmpeg } from "../docker.ts";
import type { ProfileConfig } from "../profiles.ts";
import { ensureDir } from "../util/fs.ts";

/** Frames per second of motion art. */
export const MOTION_FPS = 24;
/** Peak zoom of the push: never less than this (checked in tests). */
export const MOTION_MIN_PEAK_ZOOM = 1.2;

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

export interface MotionPlan {
  frames: number;
  /** Peak zoom, reached half-way. */
  peak: number;
  /** Focus point at the start and the end of the drift, as fractions of the free margin. */
  from: readonly [number, number];
  to: readonly [number, number];
  /** The light crosses left to right (else right to left), at this height (fraction). */
  leftToRight: boolean;
  lightY: number;
}

export function motionPlan(seed: number, durationSec: number): MotionPlan {
  const [peak = 0, ax = 0, ay = 0, bx = 0, by = 0, light = 0] = seeded(seed, 6);
  return {
    frames: Math.round(durationSec * MOTION_FPS),
    peak: MOTION_MIN_PEAK_ZOOM + peak * 0.05,
    from: [0.3 + ax * 0.4, 0.3 + ay * 0.3],
    to: [0.3 + bx * 0.4, 0.35 + by * 0.3],
    leftToRight: light < 0.5,
    lightY: 0.45 - light * 0.3,
  };
}

/** Zoom at output frame `n` (1 at both ends, `peak` half-way, eased). */
export function zoomAt(plan: MotionPlan, n: number): number {
  return 1 + (plan.peak - 1) * Math.sin((Math.PI * n) / (plan.frames - 1)) ** 2;
}

/**
 * The filter graph. Inputs: 0 = the backdrop master (1920×1080), 1 = the light sprite
 * (looped). The still is upscaled 2x first so the push moves in sub-pixel steps; the light is
 * composited in RGB and the result converted to BT.709 limited range once, at the end.
 */
export function motionArtFilter(
  seed: number,
  durationSec: number,
  width: number,
  height: number,
): string {
  const plan = motionPlan(seed, durationSec);
  const last = plan.frames - 1;
  const fixed = (value: number) => value.toFixed(4);
  const zoom = `1+${fixed(plan.peak - 1)}*pow(sin(PI*on/${last}),2)`;
  const along = `on/${last}`;
  const fx = `(${fixed(plan.from[0])}+${fixed(plan.to[0] - plan.from[0])}*${along})`;
  const fy = `(${fixed(plan.from[1])}+${fixed(plan.to[1] - plan.from[1])}*${along})`;
  // The sprite is as wide as the frame and starts and ends just outside it.
  const x0 = plan.leftToRight ? -width : width;
  const x1 = plan.leftToRight ? width : -width;
  const lightY = Math.round(-height * plan.lightY);
  return [
    `[0:v]scale=3840:2160:flags=lanczos,format=rgb24,zoompan=z='${zoom}':x='(iw-iw/zoom)*${fx}':y='(ih-ih/zoom)*${fy}':d=${plan.frames}:s=${width}x${height}:fps=${MOTION_FPS}[base]`,
    "[1:v]format=rgba[light]",
    `[base][light]overlay=x='${x0}+(${x1 - x0})*n/${last}':y=${lightY}:eval=frame:format=rgb:shortest=1,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p,setsar=1[v]`,
  ].join(";");
}

/** A soft warm light sprite (transparent edges): frame-wide, twice the frame's height. */
async function lightSprite(target: string, width: number, height: number): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height * 2}"><defs><radialGradient id="l" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff3df" stop-opacity="0.3"/><stop offset="0.45" stop-color="#ffe9c8" stop-opacity="0.12"/><stop offset="1" stop-color="#ffe9c8" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#l)"/></svg>`;
  await ensureDir(join(target, ".."));
  await sharp(Buffer.from(svg)).png().toFile(target);
}

/** BT.709 tags on the encoded stream (what the conversion above produced). */
export const BT709_TAGS = [
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-color_range",
  "tv",
] as const;

/** Render the motion-art preview MP4 (video only) for a backdrop master. */
export async function encodeMotionArt(
  backdrop: string,
  seed: number,
  durationSec: number,
  config: ProfileConfig,
  target: string,
  work: string,
): Promise<void> {
  const { width, height, maxrateKbps, crf } = config.preview;
  const light = join(work, "light.png");
  await lightSprite(light, width, height);
  await ensureDir(join(target, ".."));
  await ffmpeg([
    "-i",
    containerPath(backdrop),
    "-loop",
    "1",
    "-framerate",
    String(MOTION_FPS),
    "-i",
    containerPath(light),
    "-filter_complex",
    motionArtFilter(seed, durationSec, width, height),
    "-map",
    "[v]",
    "-frames:v",
    String(motionPlan(seed, durationSec).frames),
    "-an",
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
    // Key frames every 2 s and on the last frame, so the clip also ends on a full-quality
    // picture of the still.
    "-force_key_frames",
    `expr:gte(t,n_forced*2)+eq(n,${motionPlan(seed, durationSec).frames - 1})`,
    ...BT709_TAGS,
    "-avoid_negative_ts",
    "disabled",
    "-movflags",
    "+faststart+negative_cts_offsets",
    containerPath(target),
  ]);
}
